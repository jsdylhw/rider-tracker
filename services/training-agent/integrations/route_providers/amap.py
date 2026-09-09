"""Production adapter for AMap Web Service bicycling directions.

AMap only accepts an origin and a destination for its bicycling endpoint.  The
existing route-composition algorithm sometimes needs a via point to test a
road-corridor candidate, so :meth:`AmapCyclingRouter.route_points` composes
pairwise bicycle routes and preserves the intermediate point explicitly.
"""

from __future__ import annotations

import json
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener


AMAP_BICYCLING_URL = "https://restapi.amap.com/v5/direction/bicycling"


@dataclass(frozen=True)
class AmapPoint:
    """AMap/GCJ-02 point in latitude, longitude order for consistency with the planner."""

    lat: float
    lon: float

    def api_value(self) -> str:
        return f"{self.lon:.6f},{self.lat:.6f}"


def parse_polyline(value: str) -> list[tuple[float, float]]:
    """Parse AMap's ``lon,lat;lon,lat`` polyline form into GeoJSON ordering."""
    coordinates: list[tuple[float, float]] = []
    for pair in value.split(";"):
        try:
            lon, lat = (float(part) for part in pair.split(",", 1))
        except ValueError as exc:
            raise ValueError(f"invalid AMap polyline pair: {pair!r}") from exc
        coordinates.append((lon, lat))
    if len(coordinates) < 2:
        raise ValueError("AMap polyline must contain at least two points")
    return coordinates


def _path_coordinates(path: dict[str, Any]) -> list[tuple[float, float]]:
    coordinates: list[tuple[float, float]] = []
    for step in path.get("steps") or []:
        polyline = step.get("polyline")
        if not polyline:
            continue
        step_coordinates = parse_polyline(str(polyline))
        if coordinates and step_coordinates[0] == coordinates[-1]:
            step_coordinates = step_coordinates[1:]
        coordinates.extend(step_coordinates)
    if len(coordinates) < 2:
        raise RuntimeError("AMap response did not contain a usable bicycling geometry")
    return coordinates


def _successful_path(payload: dict[str, Any]) -> dict[str, Any]:
    # The current v5 endpoint reports ``status=1`` / ``infocode=10000``.
    # Keep the older ``errcode`` check for a compatible error response shape.
    status = payload.get("status")
    infocode = payload.get("infocode")
    errcode = payload.get("errcode")
    if (status is not None and str(status) != "1") or (infocode is not None and str(infocode) != "10000") or (errcode is not None and str(errcode) not in {"0", "10000"}):
        detail = payload.get("errdetail") or payload.get("errmsg") or payload.get("info") or "AMap bicycling request failed"
        raise RuntimeError(str(detail))
    paths = ((payload.get("route") or {}).get("paths") or (payload.get("data") or {}).get("paths") or [])
    if not paths:
        raise RuntimeError(str(payload.get("errmsg") or "AMap bicycling request returned no path"))
    return dict(paths[0])


class AmapCyclingRouter:
    def __init__(self, key: str, *, base_url: str = AMAP_BICYCLING_URL, timeout_s: float = 20.0, retries: int = 2) -> None:
        if not key or key.startswith("replace-with-"):
            raise ValueError("AMAP_WEB_SERVICE_KEY is not configured")
        self.key = key
        self.base_url = base_url
        self.timeout_s = timeout_s
        self.retries = retries

    def route(self, origin: AmapPoint, destination: AmapPoint) -> dict[str, Any]:
        query = urlencode({
            "key": self.key,
            "origin": origin.api_value(),
            "destination": destination.api_value(),
            # v5 only includes per-step geometry when explicitly requested.
            "show_fields": "cost,navi,polyline",
        })
        # Prefer the configured proxy, but WSL proxy tunnels can occasionally
        # close TLS during a multi-leg plan. AMap is often directly reachable,
        # so retry the idempotent GET once without proxy before giving up.
        request_url = f"{self.base_url}?{query}"
        openers = (build_opener(ProxyHandler()), build_opener(ProxyHandler({})))
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                opener = openers[attempt % len(openers)]
                with opener.open(request_url, timeout=self.timeout_s) as response:
                    payload = json.load(response)
                break
            except (OSError, TimeoutError, URLError) as exc:
                last_error = exc
                if attempt == self.retries:
                    raise RuntimeError(f"AMap bicycling request failed after {attempt + 1} attempts: {exc.reason if isinstance(exc, URLError) else exc}") from exc
                time.sleep(0.4 * (attempt + 1))
        else:  # pragma: no cover - guarded by the final retry branch
            raise RuntimeError("AMap bicycling request failed") from last_error
        path = _successful_path(payload)
        coordinates = _path_coordinates(path)
        return {
            "provider": "amap",
            "profile": "bicycling",
            "distance_m": float(path.get("distance") or 0),
            "duration_s": float(path.get("duration") or 0),
            "ascend_m": None,
            "geometry": coordinates,
            "instructions": list(path.get("steps") or []),
            "raw": payload,
        }

    def route_points(self, points: Sequence[AmapPoint]) -> dict[str, Any]:
        """Compose pairwise bicycle routes, retaining every supplied via point."""
        if len(points) < 2:
            raise ValueError("route_points requires at least two points")
        legs = [self.route(origin, destination) for origin, destination in zip(points, points[1:])]
        geometry: list[tuple[float, float]] = []
        for leg in legs:
            leg_geometry = list(leg["geometry"])
            if geometry and leg_geometry[0] == geometry[-1]:
                leg_geometry = leg_geometry[1:]
            geometry.extend(leg_geometry)
        return {
            "provider": "amap",
            "profile": "bicycling",
            "distance_m": sum(float(leg["distance_m"]) for leg in legs),
            "duration_s": sum(float(leg["duration_s"]) for leg in legs),
            "ascend_m": None,
            "geometry": geometry,
            "legs": legs,
            # Keep a GraphHopper-compatible shape so existing candidate code
            # can retain its geometry/overlap scoring unchanged.
            "raw": {"paths": [{"points": {"coordinates": geometry}}]},
            "details": {},
        }
