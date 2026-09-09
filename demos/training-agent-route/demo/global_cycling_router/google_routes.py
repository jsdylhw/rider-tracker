"""Google Routes adapter with a Japan drive-mode fallback for virtual rides."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
GOOGLE_ROUTES_FIELD_MASK = "routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring"
JsonTransport = Callable[[Request, float], dict[str, Any]]


@dataclass(frozen=True)
class WgsPoint:
    lat: float
    lon: float

    def __post_init__(self) -> None:
        if not -90 <= self.lat <= 90 or not -180 <= self.lon <= 180:
            raise ValueError("point is outside the WGS-84 coordinate range")

    def as_waypoint(self) -> dict[str, Any]:
        return {"location": {"latLng": {"latitude": self.lat, "longitude": self.lon}}}


class GoogleRoutesClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = GOOGLE_ROUTES_URL,
        timeout_s: float = 30.0,
        retries: int = 2,
        retry_delay_s: float = 0.4,
        transport: JsonTransport | None = None,
    ) -> None:
        if not api_key or api_key.startswith("replace-with-"):
            raise ValueError("GOOGLE_MAPS_API_KEY is not configured")
        self.api_key = api_key
        self.base_url = base_url
        self.timeout_s = timeout_s
        self.retries = retries
        self.retry_delay_s = retry_delay_s
        self.transport = transport or _read_json

    def route(
        self,
        points: Sequence[WgsPoint],
        *,
        country_code: str = "",
    ) -> dict[str, Any]:
        if len(points) < 2:
            raise ValueError("cycling route requires at least two points")
        normalized_country = str(country_code or "").strip().upper()
        # Google currently has no Biking Directions coverage in Japan. For
        # this virtual-only demo a quiet-road driving route is an acceptable
        # visual path; it is never presented as outdoor cycling navigation.
        mode = "DRIVE" if normalized_country == "JP" else "BICYCLE"
        fallback_reason = "google_bicycle_not_supported_in_japan" if mode == "DRIVE" else None
        response = self._compute(points, mode=mode)
        routes = response.get("routes") or []
        if not routes and mode == "BICYCLE":
            mode = "DRIVE"
            fallback_reason = "google_bicycle_route_unavailable"
            response = self._compute(points, mode=mode)
            routes = response.get("routes") or []
        if not routes or not isinstance(routes[0], dict):
            raise RuntimeError("Google Routes returned no usable route")
        route = routes[0]
        geometry = (route.get("polyline") or {}).get("geoJsonLinestring")
        if not isinstance(geometry, dict) or geometry.get("type") != "LineString" or len(geometry.get("coordinates") or []) < 2:
            raise RuntimeError("Google Routes did not return a usable GeoJSON LineString")
        result = {
            "schema_version": "cycling_route.v1",
            "provider": "google_routes",
            "requested_mode": "BICYCLE",
            "travel_mode": mode,
            "coordinate_system": "wgs84",
            "distance_m": float(route.get("distanceMeters") or 0),
            "duration_s": _duration_seconds(route.get("duration")),
            "geometry": {
                "type": "LineString",
                "coordinates": [[float(lon), float(lat)] for lon, lat, *_ in geometry["coordinates"]],
            },
            "instructions": [],
        }
        if fallback_reason:
            result["fallback_reason"] = fallback_reason
            result["warning"] = "该路线使用避开高速、收费和轮渡的驾车路径，仅用于虚拟街景，不是户外骑行导航。"
        return result

    def _compute(self, points: Sequence[WgsPoint], *, mode: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "origin": points[0].as_waypoint(),
            "destination": points[-1].as_waypoint(),
            "travelMode": mode,
            "computeAlternativeRoutes": False,
            "polylineQuality": "HIGH_QUALITY",
            "polylineEncoding": "GEO_JSON_LINESTRING",
            "languageCode": "zh-CN",
            "units": "METRIC",
        }
        if len(points) > 2:
            payload["intermediates"] = [point.as_waypoint() for point in points[1:-1]]
        if mode == "DRIVE":
            payload["routeModifiers"] = {
                "avoidTolls": True,
                "avoidHighways": True,
                "avoidFerries": True,
            }
        request = Request(
            self.base_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": GOOGLE_ROUTES_FIELD_MASK,
            },
            method="POST",
        )
        for attempt in range(self.retries + 1):
            try:
                return self.transport(request, self.timeout_s)
            except TransientProviderError:
                if attempt >= self.retries:
                    raise
                time.sleep(self.retry_delay_s * (attempt + 1))
        raise RuntimeError("Google Routes retry loop ended unexpectedly")  # pragma: no cover


class TransientProviderError(RuntimeError):
    """Retryable transport failure after no provider response was received."""


def _duration_seconds(value: Any) -> float:
    text = str(value or "0s").strip()
    if not text.endswith("s"):
        raise RuntimeError("Google Routes returned an invalid duration")
    try:
        return float(text[:-1] or 0)
    except ValueError as exc:
        raise RuntimeError("Google Routes returned an invalid duration") from exc


def _read_json(request: Request, timeout_s: float) -> dict[str, Any]:
    try:
        with urlopen(request, timeout=timeout_s) as response:  # noqa: S310 - fixed HTTPS provider URL
            payload = json.load(response)
    except HTTPError as exc:
        detail = _http_error_detail(exc)
        raise RuntimeError(f"Google Routes returned HTTP {exc.code}: {detail}") from exc
    except (TimeoutError, URLError, OSError) as exc:
        reason = getattr(exc, "reason", None)
        raise TransientProviderError(f"Google Routes request failed: {reason or exc.__class__.__name__}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Google Routes returned an invalid JSON object")
    return payload


def _http_error_detail(exc: HTTPError) -> str:
    try:
        payload = json.loads(exc.read().decode("utf-8", errors="replace"))
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
    except (OSError, ValueError):
        pass
    return str(exc.reason or "provider error")
