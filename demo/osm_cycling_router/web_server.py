#!/usr/bin/env python3
"""Local-only web facade for the OSM cycling-router demo.

The browser talks only to this server. It exposes a deliberately small API:
local scenic-place search and a read-only proxy to the local GraphHopper
instance. This keeps the demo self-contained without turning it into a
production geocoding or route-planning service.
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
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import ProxyHandler, build_opener

try:  # package import for tests; direct import for the Docker image
    from .free_loop import plan_free_loop
    from .places import nearby_scenic_places, search_places
    from .router import Point, VALID_PROFILES
except ImportError:  # pragma: no cover - exercised by the Docker entrypoint
    from free_loop import plan_free_loop
    from places import nearby_scenic_places, search_places
    from router import Point, VALID_PROFILES


MAX_RESULTS = 20
MAX_ROUTE_POINTS = 8
MAX_FREE_LOOP_CANDIDATES = 5
ROUTE_PROBE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def parse_point(value: str) -> tuple[float, float]:
    try:
        lat, lon = (float(part.strip()) for part in value.split(",", 1))
    except (AttributeError, ValueError) as exc:
        raise ValueError("point must be formatted as 'lat,lon'") from exc
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError("point is outside the WGS-84 coordinate range")
    return lat, lon


def bounded_int(value: str | None, *, default: int, maximum: int) -> int:
    if value is None:
        return default
    number = int(value)
    if not 1 <= number <= maximum:
        raise ValueError(f"value must be between 1 and {maximum}")
    return number


def bounded_float(value: str | None, *, minimum: float, maximum: float, name: str) -> float:
    if value is None:
        raise ValueError(f"{name} is required")
    number = float(value)
    if not minimum <= number <= maximum:
        raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")
    return number


def graphhopper_route(base_url: str, query: dict[str, list[str]]) -> dict[str, Any]:
    points = query.get("point", [])
    if not 2 <= len(points) <= MAX_ROUTE_POINTS:
        raise ValueError(f"route requires between 2 and {MAX_ROUTE_POINTS} points")
    for point in points:
        parse_point(point)

    profile = (query.get("profile") or ["racingbike"])[0]
    if profile not in VALID_PROFILES:
        raise ValueError("profile must be 'car', 'bike' or 'racingbike'")

    request_query: list[tuple[str, str]] = [
        *(('point', point) for point in points),
        ("profile", profile),
        ("points_encoded", "false"),
        ("instructions", "true"),
    ]
    # The container inherits proxy variables for map downloads. Local routing
    # must never be sent through that proxy.
    request_url = f"{base_url.rstrip('/')}/route?{urlencode(request_query)}"
    opener = build_opener(ProxyHandler({}))
    with opener.open(request_url, timeout=30) as response:
        payload = json.load(response)
    if not payload.get("paths"):
        raise RuntimeError(payload.get("message") or "GraphHopper returned no route")
    return payload


def graphhopper_free_loop(base_url: str, query: dict[str, list[str]]) -> dict[str, Any]:
    point = parse_point((query.get("point") or [""])[0])
    profile = (query.get("profile") or ["racingbike"])[0]
    if profile not in VALID_PROFILES:
        raise ValueError("profile must be 'car', 'bike' or 'racingbike'")
    distance_km = bounded_float(
        (query.get("distance_km") or [None])[0], minimum=1, maximum=300, name="distance_km",
    )
    count = bounded_int(
        (query.get("count") or [None])[0], default=3, maximum=MAX_FREE_LOOP_CANDIDATES,
    )
    plan = plan_free_loop(
        Point(*point),
        target_distance_m=distance_km * 1_000,
        profile=profile,
        max_candidates=count,
        base_url=base_url,
    )
    return plan.as_dict()


def load_route_probe(probe_dir: Path, name: str) -> dict[str, Any]:
    """Load a locally generated route experiment without exposing arbitrary files."""
    if not ROUTE_PROBE_NAME.fullmatch(name):
        raise ValueError("invalid route probe name")
    path = probe_dir / f"{name}.geojson"
    if not path.is_file():
        raise FileNotFoundError(f"route probe '{name}' is not available")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
        raise RuntimeError("route probe is not valid GeoJSON")
    return payload


def create_server(
    *,
    host: str,
    port: int,
    static_dir: Path,
    database: Path,
    graphhopper_url: str,
    route_probe_dir: Path | None = None,
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "OSMCyclingRouterDemo/1.0"

        def log_message(self, format: str, *args: object) -> None:
            print(f"[web] {self.address_string()} {format % args}")

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
                    self.send_json({"status": "ok"})
                elif parsed.path == "/api/places/search":
                    term = (query.get("q") or [""])[0]
                    near = parse_point((query.get("near") or [""])[0]) if query.get("near") else None
                    limit = bounded_int((query.get("limit") or [None])[0], default=8, maximum=MAX_RESULTS)
                    results = search_places(database, term, near=near, limit=limit)
                    self.send_json({"places": [item.as_dict() for item in results]})
                elif parsed.path == "/api/places/nearby":
                    point = parse_point((query.get("point") or [""])[0])
                    radius_m = float((query.get("radius_m") or ["5000"])[0])
                    limit = bounded_int((query.get("limit") or [None])[0], default=12, maximum=MAX_RESULTS)
                    results = nearby_scenic_places(
                        database, lat=point[0], lon=point[1], radius_m=radius_m, limit=limit,
                    )
                    self.send_json({"places": [item.as_dict() for item in results]})
                elif parsed.path == "/api/route":
                    self.send_json(graphhopper_route(graphhopper_url, query))
                elif parsed.path == "/api/free-loop":
                    self.send_json(graphhopper_free_loop(graphhopper_url, query))
                elif parsed.path.startswith("/api/route-probes/"):
                    if route_probe_dir is None:
                        raise FileNotFoundError("route probe directory is not configured")
                    name = parsed.path.removeprefix("/api/route-probes/")
                    self.send_json(load_route_probe(route_probe_dir, name))
                elif parsed.path == "/" or parsed.path.startswith("/static/"):
                    self.serve_static(parsed.path)
                else:
                    self.send_error_json("not found", HTTPStatus.NOT_FOUND)
            except ValueError as exc:
                self.send_error_json(str(exc))
            except FileNotFoundError as exc:
                self.send_error_json(str(exc), HTTPStatus.NOT_FOUND)
            except Exception as exc:  # noqa: BLE001 - error must become browser-readable JSON
                self.send_error_json(str(exc), HTTPStatus.BAD_GATEWAY)

    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the local cycling-router demo UI")
    parser.add_argument("--host", default=os.getenv("WEB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("WEB_PORT", "8080")))
    parser.add_argument("--database", type=Path, default=Path(os.getenv("PLACES_DB", "/app/data/scenic_places.sqlite")))
    parser.add_argument("--route-probe-dir", type=Path, default=Path(os.getenv("ROUTE_PROBE_DIR", "/app/data/route-probes")))
    parser.add_argument("--graphhopper-url", default=os.getenv("GRAPHHOPPER_URL", "http://127.0.0.1:8989"))
    args = parser.parse_args()
    static_dir = Path(__file__).with_name("web")
    if not args.database.is_file():
        raise SystemExit(f"Missing scenic-place index: {args.database}")
    print(f"[web] serving http://{args.host}:{args.port}")
    create_server(
        host=args.host,
        port=args.port,
        static_dir=static_dir,
        database=args.database,
        graphhopper_url=args.graphhopper_url,
        route_probe_dir=args.route_probe_dir,
    ).serve_forever()


if __name__ == "__main__":
    main()
