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
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, build_opener

from integrations.provider_error import ProviderError, TransientProviderError


AMAP_BICYCLING_URL = "https://restapi.amap.com/v5/direction/bicycling"
_TRANSIENT_PROVIDER_MARKERS = (
    "QPS_HAS_EXCEEDED_THE_LIMIT",
    "SERVICE_NOT_AVAILABLE",
)


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
        try:
            step_coordinates = parse_polyline(str(polyline))
        except ValueError as exc:
            raise ProviderError(
                "AMap response contained invalid bicycling geometry",
                provider="amap",
                stage="route_calculation",
                code="provider_invalid_response",
            ) from exc
        if coordinates and step_coordinates[0] == coordinates[-1]:
            step_coordinates = step_coordinates[1:]
        coordinates.extend(step_coordinates)
    if len(coordinates) < 2:
        raise ProviderError(
            "AMap response did not contain a usable bicycling geometry",
            provider="amap",
            stage="route_calculation",
            code="provider_invalid_response",
        )
    return coordinates


def _successful_path(payload: dict[str, Any]) -> dict[str, Any]:
    return _successful_paths(payload)[0]


def _successful_paths(payload: dict[str, Any]) -> list[dict[str, Any]]:
    validate_amap_response(payload, stage="route_calculation")
    paths = ((payload.get("route") or {}).get("paths") or (payload.get("data") or {}).get("paths") or [])
    normalized = [dict(path) for path in paths if isinstance(path, dict)]
    if not normalized:
        raise ProviderError(
            str(payload.get("errmsg") or "AMap bicycling request returned no path"),
            provider="amap",
            stage="route_calculation",
            code="provider_no_route",
        )
    return normalized


def validate_amap_response(payload: dict[str, Any], *, stage: str) -> None:
    """Classify an AMap API error before consumers inspect result collections."""
    # The current v5 endpoint reports ``status=1`` / ``infocode=10000``.
    # Keep the older ``errcode`` check for a compatible error response shape.
    status = payload.get("status")
    infocode = payload.get("infocode")
    errcode = payload.get("errcode")
    if (status is not None and str(status) != "1") or (infocode is not None and str(infocode) != "10000") or (errcode is not None and str(errcode) not in {"0", "10000"}):
        detail = payload.get("errdetail") or payload.get("errmsg") or payload.get("info") or "AMap bicycling request failed"
        error_type = TransientProviderError if _is_transient_provider_response(payload) else ProviderError
        raise error_type(str(detail), provider="amap", stage=stage)


def _is_transient_provider_response(payload: dict[str, Any]) -> bool:
    detail = " ".join(
        str(payload.get(key) or "")
        for key in ("info", "errmsg", "errdetail")
    ).upper()
    return any(marker in detail for marker in _TRANSIENT_PROVIDER_MARKERS)


def _normalize_step(step: dict[str, Any]) -> dict[str, Any]:
    """Keep stable navigation evidence without duplicating the full provider payload."""
    cost = step.get("cost") if isinstance(step.get("cost"), dict) else {}
    navi = step.get("navi") if isinstance(step.get("navi"), dict) else {}
    return {
        "instruction": str(step.get("instruction") or ""),
        "orientation": str(step.get("orientation") or ""),
        "road_name": str(step.get("road_name") or step.get("road") or ""),
        "distance_m": float(step.get("step_distance") or step.get("distance") or 0),
        "duration_s": float(step.get("duration") or cost.get("duration") or 0),
        "action": str(navi.get("action") or step.get("action") or ""),
        "assistant_action": str(
            navi.get("assistant_action") or step.get("assistant_action") or ""
        ),
        "walk_type": str(navi.get("walk_type") or step.get("walk_type") or ""),
    }


def _normalize_path(path: dict[str, Any]) -> dict[str, Any]:
    coordinates = _path_coordinates(path)
    cost = path.get("cost") if isinstance(path.get("cost"), dict) else {}
    return {
        "provider": "amap",
        "profile": "bicycling",
        "distance_m": float(path.get("distance") or 0),
        "duration_s": float(path.get("duration") or cost.get("duration") or 0),
        "ascend_m": None,
        "geometry": coordinates,
        "instructions": [
            _normalize_step(step)
            for step in path.get("steps") or []
            if isinstance(step, dict)
        ],
    }


class AmapCyclingRouter:
    def __init__(self, key: str, *, base_url: str = AMAP_BICYCLING_URL, timeout_s: float = 20.0, retries: int = 2) -> None:
        if not key or key.startswith("replace-with-"):
            raise ValueError("AMAP_WEB_SERVICE_KEY is not configured")
        self.key = key
        self.base_url = base_url
        self.timeout_s = timeout_s
        self.retries = retries

    def route(
        self,
        origin: AmapPoint,
        destination: AmapPoint,
        *,
        alternative_route: int = 1,
    ) -> dict[str, Any]:
        return self.route_alternatives(
            origin,
            destination,
            alternative_route=alternative_route,
        )[0]

    def route_alternatives(
        self,
        origin: AmapPoint,
        destination: AmapPoint,
        *,
        alternative_route: int = 3,
    ) -> list[dict[str, Any]]:
        route_count = max(1, min(3, int(alternative_route)))
        query = urlencode({
            "key": self.key,
            "origin": origin.api_value(),
            "destination": destination.api_value(),
            # v5 only includes per-step geometry when explicitly requested.
            "show_fields": "cost,navi,polyline",
            "alternative_route": route_count,
        })
        # AMap is a domestic service and is normally reachable directly. Try
        # direct access first so an unavailable proxy cannot add one timeout to
        # every leg of a multi-leg plan; retain the proxy as a fallback for
        # installations whose outbound traffic requires it.
        request_url = f"{self.base_url}?{query}"
        openers = (build_opener(ProxyHandler({})), build_opener(ProxyHandler()))
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                opener = openers[attempt % len(openers)]
                with opener.open(request_url, timeout=self.timeout_s) as response:
                    payload = json.load(response)
                try:
                    paths = _successful_paths(payload)
                except ProviderError as exc:
                    if not _is_transient_provider_response(payload):
                        raise
                    if attempt == self.retries:
                        raise TransientProviderError(
                            str(exc), provider="amap", stage="route_calculation",
                        ) from exc
                    last_error = exc
                    time.sleep(0.8 * (attempt + 1))
                    continue
                return [_normalize_path(path) for path in paths]
            except HTTPError as exc:
                last_error = exc
                message = f"AMap bicycling returned HTTP {exc.code}"
                if exc.code in {408, 429} or exc.code >= 500:
                    if attempt < self.retries:
                        time.sleep(0.4 * (attempt + 1))
                        continue
                    raise TransientProviderError(
                        message, provider="amap", stage="route_calculation",
                    ) from exc
                raise ProviderError(
                    message,
                    provider="amap",
                    stage="route_calculation",
                    code="provider_http_error",
                ) from exc
            except json.JSONDecodeError as exc:
                raise ProviderError(
                    "AMap bicycling returned invalid JSON",
                    provider="amap",
                    stage="route_calculation",
                    code="provider_invalid_response",
                ) from exc
            except (OSError, TimeoutError, URLError) as exc:
                last_error = exc
                if attempt == self.retries:
                    raise TransientProviderError(
                        f"AMap bicycling request failed after {attempt + 1} attempts: "
                        f"{exc.reason if isinstance(exc, URLError) else exc}",
                        provider="amap",
                        stage="route_calculation",
                    ) from exc
                time.sleep(0.4 * (attempt + 1))
        raise TransientProviderError(
            "AMap bicycling request failed",
            provider="amap",
            stage="route_calculation",
        ) from last_error  # pragma: no cover

    def route_points(self, points: Sequence[AmapPoint]) -> dict[str, Any]:
        """Compose pairwise bicycle routes, retaining every supplied via point."""
        if len(points) < 2:
            raise ValueError("route_points requires at least two points")
        legs = [self.route(origin, destination) for origin, destination in zip(points, points[1:])]
        return _compose_legs(legs)

    def route_point_leg_alternatives(
        self,
        points: Sequence[AmapPoint],
        *,
        alternative_route: int = 3,
    ) -> list[list[dict[str, Any]]]:
        """Return provider alternatives for each fixed pair of ordered anchors."""
        if len(points) < 2:
            raise ValueError("route_point_leg_alternatives requires at least two points")
        return [
            self.route_alternatives(origin, destination, alternative_route=alternative_route)
            for origin, destination in zip(points, points[1:])
        ]


def compose_amap_legs(legs: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Public composition boundary used by the route-ranking service."""
    return _compose_legs(legs)


def _compose_legs(legs: Sequence[dict[str, Any]]) -> dict[str, Any]:
    if not legs:
        raise ValueError("at least one AMap route leg is required")
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
        "legs": list(legs),
        "instructions": [
            step
            for leg in legs
            for step in leg.get("instructions") or []
            if isinstance(step, dict)
        ],
        # Keep a GraphHopper-compatible shape so existing candidate code
        # can retain its geometry/overlap scoring unchanged.
        "raw": {"paths": [{"points": {"coordinates": geometry}}]},
        "details": {},
    }
