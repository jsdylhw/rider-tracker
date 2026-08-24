"""Minimal, dependency-free GraphHopper route probe helpers.

This is deliberately demo-local.  The production route domain should only be
created after the generated routes have been compared with real FIT tracks.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Sequence
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import ProxyHandler, build_opener, urlopen

SEMICIRCLE_TO_DEGREES = 180.0 / (1 << 31)
VALID_PROFILES = frozenset({"car", "bike", "racingbike"})


@dataclass(frozen=True)
class Point:
    lat: float
    lon: float

    def query_value(self) -> str:
        return f"{self.lat:.7f},{self.lon:.7f}"


def semicircles_to_degrees(value: Any) -> float:
    """Convert a Garmin FIT semicircle coordinate into WGS-84 degrees."""
    return float(value) * SEMICIRCLE_TO_DEGREES


def endpoints_from_fit(path: str | Path) -> tuple[Point, Point]:
    """Read the first and last GPS record from a local FIT file.

    FIT positions are kept in WGS-84.  Do not apply a GCJ-02 conversion before
    sending them to an OSM routing engine.
    """
    project_root = Path(__file__).resolve().parents[2]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    from fit.parser import parse_fit

    parsed = parse_fit(Path(path))
    points = [
        Point(
            lat=semicircles_to_degrees(record["position_lat"]),
            lon=semicircles_to_degrees(record["position_long"]),
        )
        for record in parsed.get("records") or []
        if record.get("position_lat") is not None and record.get("position_long") is not None
    ]
    if len(points) < 2:
        raise ValueError("FIT file has fewer than two GPS records")
    return points[0], points[-1]


def route(
    origin: Point,
    destination: Point,
    *,
    profile: str = "bike",
    base_url: str = "http://127.0.0.1:8989",
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    """Call a local GraphHopper instance and return normalized route facts."""
    return route_points((origin, destination), profile=profile, base_url=base_url, timeout_s=timeout_s)


def route_points(
    points: Sequence[Point],
    *,
    profile: str = "bike",
    base_url: str = "http://127.0.0.1:8989",
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    """Route through two or more local WGS-84 points, preserving via points."""
    if profile not in VALID_PROFILES:
        raise ValueError("profile must be car, bike or racingbike")
    if len(points) < 2:
        raise ValueError("route_points requires at least two points")
    query = urlencode([
        *(("point", point.query_value()) for point in points),
        ("profile", profile),
        ("points_encoded", "false"),
        ("instructions", "true"),
        ("details", "road_class"),
        ("details", "surface"),
        ("details", "bike_priority"),
        ("details", "osm_way_id"),
    ])
    return _route_request(query, profile=profile, base_url=base_url, timeout_s=timeout_s)


def round_trip(
    origin: Point,
    *,
    distance_m: float,
    seed: int,
    profile: str = "racingbike",
    base_url: str = "http://127.0.0.1:8989",
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    """Generate one local GraphHopper free-loop candidate.

    GraphHopper's ``round_trip`` is a heuristic, not a landmark-aware route:
    ``distance_m`` is an approximate target and ``seed`` creates another
    geometry.  It requires flexible routing, hence ``ch.disable=true`` even
    though normal two-point requests use the faster CH preparation.
    """
    if profile not in VALID_PROFILES:
        raise ValueError("profile must be car, bike or racingbike")
    if not 1_000 <= distance_m <= 300_000:
        raise ValueError("distance_m must be between 1000 and 300000")
    if seed < 0:
        raise ValueError("seed must be non-negative")
    query = urlencode([
        ("point", origin.query_value()),
        ("profile", profile),
        ("algorithm", "round_trip"),
        ("round_trip.distance", f"{distance_m:.0f}"),
        ("round_trip.seed", str(seed)),
        ("ch.disable", "true"),
        ("points_encoded", "false"),
        ("instructions", "true"),
        ("details", "road_class"),
        ("details", "surface"),
        ("details", "bike_priority"),
        ("details", "osm_way_id"),
    ])
    return _route_request(query, profile=profile, base_url=base_url, timeout_s=timeout_s)


def _route_request(query: str, *, profile: str, base_url: str, timeout_s: float) -> dict[str, Any]:
    """Issue a direct request to the local GraphHopper HTTP service."""
    request_url = f"{base_url.rstrip('/')}/route?{query}"
    host = (urlparse(request_url).hostname or "").lower()
    # WSL environments frequently set an HTTP proxy that incorrectly captures
    # localhost. The self-hosted router must always be reached directly.
    opener = build_opener(ProxyHandler({})) if host in {"127.0.0.1", "localhost", "::1"} else None
    open_request = opener.open if opener else urlopen
    with open_request(request_url, timeout=timeout_s) as response:
        payload = json.load(response)
    if payload.get("message") or not payload.get("paths"):
        raise RuntimeError(payload.get("message") or "GraphHopper returned no path")
    path = payload["paths"][0]
    return {
        "profile": profile,
        "distance_m": float(path.get("distance") or 0),
        "duration_s": float(path.get("time") or 0) / 1000.0,
        "ascend_m": float(path.get("ascend") or 0),
        "descend_m": float(path.get("descend") or 0),
        "point_count": len(((path.get("points") or {}).get("coordinates") or [])),
        "instruction_count": len(path.get("instructions") or []),
        "details": path.get("details") or {},
        "raw": payload,
    }
