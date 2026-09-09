#!/usr/bin/env python3
"""Local web facade for global place search and hosted cycling routing."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

try:
    from .google_places import GooglePlacesClient
    from .google_routes import GoogleRoutesClient, WgsPoint
except ImportError:  # pragma: no cover - direct script invocation
    from google_places import GooglePlacesClient
    from google_routes import GoogleRoutesClient, WgsPoint


def load_local_env(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_provider_settings(demo_dir: Path) -> dict[str, str]:
    """Load ignored local config while allowing environment overrides."""
    load_local_env(demo_dir / ".env")
    config_path = demo_dir.parents[1] / "config.yaml"
    configured: dict[str, Any] = {}
    if config_path.is_file():
        try:
            from settings import load_config

            configured = load_config(config_path)
        except (ImportError, ValueError):
            configured = {}
    legacy_google_config = configured.get("google_maps") if isinstance(configured, dict) else {}
    google_config = configured.get("google") if isinstance(configured, dict) else {}
    if not isinstance(google_config, dict) or not google_config.get("api_key"):
        google_config = legacy_google_config
    if isinstance(google_config, dict) and google_config.get("api_key"):
        os.environ.setdefault("GOOGLE_MAPS_API_KEY", str(google_config["api_key"]))
    return {
        "google_api_key": os.getenv("GOOGLE_MAPS_API_KEY", ""),
    }


def parse_wgs_point(value: str) -> WgsPoint:
    try:
        latitude, longitude = (float(part.strip()) for part in value.split(",", 1))
    except (AttributeError, ValueError) as exc:
        raise ValueError("point must be formatted as 'latitude,longitude' (WGS-84)") from exc
    return WgsPoint(lat=latitude, lon=longitude)


def _int_parameter(value: str, *, name: str, default: int, minimum: int, maximum: int) -> int:
    if not str(value or "").strip():
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= parsed <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def create_server(
    *,
    host: str,
    port: int,
    static_dir: Path,
    places: GooglePlacesClient,
    router: GoogleRoutesClient,
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "GlobalCyclingRouterDemo/1.0"

        def log_message(self, format: str, *args: object) -> None:
            print(f"[global-route-web] {self.address_string()} {format % args}")

        def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def send_error_json(self, message: str, status: HTTPStatus) -> None:
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

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler interface
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            try:
                if parsed.path == "/health":
                    self.send_json({
                        "status": "ok",
                        "place_provider": "google_places",
                        "route_provider": "google_routes",
                        "coordinate_system": "wgs84",
                    })
                elif parsed.path == "/api/places":
                    text = (query.get("q") or [""])[0]
                    near_value = (query.get("near") or [""])[0]
                    near_point = parse_wgs_point(near_value) if near_value else None
                    limit = _int_parameter((query.get("limit") or [""])[0], name="limit", default=5, minimum=1, maximum=20)
                    radius_m = _int_parameter(
                        (query.get("radius_m") or [""])[0],
                        name="radius_m",
                        default=20_000,
                        minimum=1,
                        maximum=50_000,
                    )
                    self.send_json(places.search(
                        text,
                        near=(near_point.lat, near_point.lon) if near_point else None,
                        radius_m=radius_m,
                        language_code=(query.get("language") or ["zh-CN"])[0],
                        limit=limit,
                    ))
                elif parsed.path == "/api/route":
                    points = [parse_wgs_point(value) for value in query.get("point") or []]
                    self.send_json(router.route(points, country_code=(query.get("country") or [""])[0]))
                elif parsed.path == "/" or parsed.path.startswith("/static/"):
                    self.serve_static(parsed.path)
                else:
                    self.send_error_json("not found", HTTPStatus.NOT_FOUND)
            except ValueError as exc:
                self.send_error_json(str(exc), HTTPStatus.BAD_REQUEST)
            except RuntimeError as exc:
                self.send_error_json(str(exc), HTTPStatus.BAD_GATEWAY)
            except Exception as exc:  # pragma: no cover - defensive local facade boundary
                self.send_error_json(f"unexpected local server error: {exc.__class__.__name__}", HTTPStatus.INTERNAL_SERVER_ERROR)

    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the hosted global cycling-route demo")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8091)
    args = parser.parse_args()
    demo_dir = Path(__file__).resolve().parent
    settings = load_provider_settings(demo_dir)
    server = create_server(
        host=args.host,
        port=args.port,
        static_dir=demo_dir / "web",
        places=GooglePlacesClient(settings["google_api_key"]),
        router=GoogleRoutesClient(settings["google_api_key"]),
    )
    print(f"Global cycling route demo: http://{args.host}:{server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
