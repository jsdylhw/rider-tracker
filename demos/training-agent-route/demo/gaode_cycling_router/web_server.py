#!/usr/bin/env python3
"""Local web facade for the AMap cycling-router experiment.

The browser receives only the JS-map credentials required by AMap JS API.
The Web Service key stays in this local process and is used only for bicycling
directions.  All browser points and returned route geometries are GCJ-02.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

try:
    from .amap import AmapCyclingRouter, AmapPoint
    from .coordinates import wgs84_to_gcj02
except ImportError:  # pragma: no cover - direct script invocation
    from amap import AmapCyclingRouter, AmapPoint
    from coordinates import wgs84_to_gcj02


ROUTE_PROBE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def load_local_env(path: Path) -> None:
    """Load a minimal local .env without adding a runtime dependency."""
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_amap_settings(demo_dir: Path) -> dict[str, str]:
    """Read local .env first, then the repository's ignored ``amap`` block.

    The root config is convenient for this repository's local experiments;
    `.env` remains useful when running this demo outside the project tree.
    Environment variables always win over both files.
    """
    load_local_env(demo_dir / ".env")
    config_path = demo_dir.parents[1] / "config.yaml"
    if config_path.is_file():
        try:
            from settings import load_config
            configured = load_config(config_path).get("amap") or {}
        except (ImportError, ValueError):
            configured = {}
        if isinstance(configured, dict):
            mapping = {
                "AMAP_WEB_SERVICE_KEY": "web_service_key",
                "AMAP_JS_KEY": "js_key",
                "AMAP_SECURITY_JS_CODE": "security_js_code",
            }
            for environment_name, config_name in mapping.items():
                value = configured.get(config_name)
                if value:
                    os.environ.setdefault(environment_name, str(value))
    return {
        "web_service_key": os.getenv("AMAP_WEB_SERVICE_KEY", ""),
        "js_key": os.getenv("AMAP_JS_KEY", ""),
        "security_js_code": os.getenv("AMAP_SECURITY_JS_CODE", ""),
    }


def parse_gcj_point(value: str) -> AmapPoint:
    try:
        lon, lat = (float(part.strip()) for part in value.split(",", 1))
    except (AttributeError, ValueError) as exc:
        raise ValueError("point must be formatted as 'longitude,latitude' (GCJ-02)") from exc
    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ValueError("point is outside the GCJ-02 coordinate range")
    return AmapPoint(lat=lat, lon=lon)


def _convert_geometry_to_gcj02(geometry: dict[str, Any]) -> dict[str, Any]:
    kind = geometry.get("type")
    if kind == "LineString":
        return {**geometry, "coordinates": [wgs84_to_gcj02(float(lon), float(lat)) for lon, lat, *_ in geometry.get("coordinates") or []]}
    if kind == "Point":
        lon, lat, *_ = geometry.get("coordinates") or []
        return {**geometry, "coordinates": wgs84_to_gcj02(float(lon), float(lat))}
    raise ValueError(f"unsupported route-probe geometry: {kind!r}")


def load_probe_as_gcj02(probe_dir: Path, name: str) -> dict[str, Any]:
    """Read a trusted local probe and convert WGS-84 input for the AMap canvas."""
    if not ROUTE_PROBE_NAME.fullmatch(name):
        raise ValueError("invalid route probe name")
    path = probe_dir / f"{name}.geojson"
    if not path.is_file():
        raise FileNotFoundError(f"route probe '{name}' is not available")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
        raise RuntimeError("route probe is not valid GeoJSON")
    source_coordinate_system = str((payload.get("metadata") or {}).get("coordinate_system") or "wgs84").lower()
    if source_coordinate_system == "gcj02":
        return payload
    if source_coordinate_system != "wgs84":
        raise ValueError(f"unsupported route-probe coordinate system: {source_coordinate_system}")
    features = []
    for feature in payload["features"]:
        features.append({**feature, "geometry": _convert_geometry_to_gcj02(dict(feature.get("geometry") or {}))})
    metadata = {**dict(payload.get("metadata") or {}), "source_coordinate_system": "wgs84", "coordinate_system": "gcj02"}
    return {**payload, "metadata": metadata, "features": features}


def create_server(
    *,
    host: str,
    port: int,
    static_dir: Path,
    router: AmapCyclingRouter,
    js_key: str,
    security_js_code: str = "",
    route_probe_dir: Path | None = None,
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "GaodeCyclingRouterDemo/1.0"

        def log_message(self, format: str, *args: object) -> None:
            print(f"[gaode-web] {self.address_string()} {format % args}")

        def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def send_error_json(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST) -> None:
            self.send_json({"error": message}, status)

        def serve_static(self, path: str) -> None:
            relative = "index.html" if path == "/" else path.removeprefix("/static/")
            candidate = (static_dir / relative).resolve()
            try:
                candidate.relative_to(static_dir.resolve())
            except ValueError:
                self.send_error_json("not found", HTTPStatus.NOT_FOUND)
                return
            if not candidate.is_file():
                self.send_error_json("not found", HTTPStatus.NOT_FOUND)
                return
            content = candidate.read_bytes()
            content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", f"{content_type}; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            try:
                if parsed.path == "/health":
                    self.send_json({"status": "ok", "provider": "amap", "coordinate_system": "gcj02"})
                elif parsed.path == "/api/config":
                    if not js_key or js_key.startswith("replace-with-"):
                        raise RuntimeError("AMAP_JS_KEY is not configured")
                    self.send_json({"js_key": js_key, "security_js_code": security_js_code, "coordinate_system": "gcj02"})
                elif parsed.path == "/api/route":
                    origin = parse_gcj_point((query.get("origin") or [""])[0])
                    destination = parse_gcj_point((query.get("destination") or [""])[0])
                    self.send_json(router.route(origin, destination))
                elif parsed.path.startswith("/api/route-probes/"):
                    if route_probe_dir is None:
                        raise FileNotFoundError("route probe directory is not configured")
                    self.send_json(load_probe_as_gcj02(route_probe_dir, parsed.path.removeprefix("/api/route-probes/")))
                elif parsed.path == "/" or parsed.path.startswith("/static/"):
                    self.serve_static(parsed.path)
                else:
                    self.send_error_json("not found", HTTPStatus.NOT_FOUND)
            except ValueError as exc:
                self.send_error_json(str(exc))
            except FileNotFoundError as exc:
                self.send_error_json(str(exc), HTTPStatus.NOT_FOUND)
            except RuntimeError as exc:
                self.send_error_json(str(exc), HTTPStatus.BAD_GATEWAY)
            except Exception as exc:  # noqa: BLE001 - external map errors must be browser-readable
                self.send_error_json(str(exc), HTTPStatus.BAD_GATEWAY)

    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    demo_dir = Path(__file__).resolve().parent
    settings = load_amap_settings(demo_dir)
    parser = argparse.ArgumentParser(description="Serve the AMap cycling-router demo")
    parser.add_argument("--host", default=os.getenv("GAODE_WEB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("GAODE_WEB_PORT", "8090")))
    parser.add_argument("--route-probe-dir", type=Path, default=os.getenv("ROUTE_PROBE_DIR") or demo_dir / "data")
    args = parser.parse_args()
    try:
        router = AmapCyclingRouter(settings["web_service_key"])
    except ValueError as exc:
        parser.error(str(exc) + "; copy .env.example to .env and fill it first")
    static_dir = demo_dir / "web"
    print(f"[gaode-web] serving http://{args.host}:{args.port}")
    create_server(
        host=args.host,
        port=args.port,
        static_dir=static_dir,
        router=router,
        js_key=settings["js_key"],
        security_js_code=settings["security_js_code"],
        route_probe_dir=args.route_probe_dir,
    ).serve_forever()


if __name__ == "__main__":
    main()
