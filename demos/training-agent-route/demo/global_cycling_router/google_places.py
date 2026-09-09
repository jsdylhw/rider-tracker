"""Small Google Places Text Search adapter for the global route demo."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


GOOGLE_PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
GOOGLE_PLACES_FIELD_MASK = ",".join((
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.types",
    "places.addressComponents",
))

JsonTransport = Callable[[Request, float], dict[str, Any]]


class GooglePlacesClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = GOOGLE_PLACES_TEXT_SEARCH_URL,
        timeout_s: float = 20.0,
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

    def search(
        self,
        query: str,
        *,
        near: tuple[float, float] | None = None,
        radius_m: float = 20_000,
        language_code: str = "zh-CN",
        limit: int = 5,
    ) -> dict[str, Any]:
        text_query = str(query or "").strip()
        if not text_query:
            raise ValueError("place query is required")
        if not 1 <= limit <= 20:
            raise ValueError("place result limit must be between 1 and 20")
        if not 0 < radius_m <= 50_000:
            raise ValueError("place search radius must be between 0 and 50000 meters")

        payload: dict[str, Any] = {
            "textQuery": text_query,
            "pageSize": limit,
            "languageCode": language_code,
        }
        if near is not None:
            latitude, longitude = near
            _validate_point(latitude, longitude)
            payload["locationBias"] = {
                "circle": {
                    "center": {"latitude": latitude, "longitude": longitude},
                    "radius": radius_m,
                }
            }

        request = Request(
            self.base_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
            },
            method="POST",
        )
        response = self._send(request)
        places = []
        for raw_place in response.get("places") or []:
            normalized = _normalize_place(raw_place)
            if normalized is not None:
                places.append(normalized)
        return {
            "schema_version": "place_search.v1",
            "provider": "google_places",
            "coordinate_system": "wgs84",
            "query": text_query,
            "places": places,
        }

    def _send(self, request: Request) -> dict[str, Any]:
        for attempt in range(self.retries + 1):
            try:
                return self.transport(request, self.timeout_s)
            except TransientProviderError:
                if attempt >= self.retries:
                    raise
                time.sleep(self.retry_delay_s * (attempt + 1))
        raise RuntimeError("Google Places retry loop ended unexpectedly")  # pragma: no cover


class TransientProviderError(RuntimeError):
    """Retryable transport failure after no provider response was received."""


def _normalize_place(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    location = value.get("location")
    if not isinstance(location, dict):
        return None
    latitude = _number(location.get("latitude"))
    longitude = _number(location.get("longitude"))
    if latitude is None or longitude is None:
        return None
    try:
        _validate_point(latitude, longitude)
    except ValueError:
        return None
    display_name = value.get("displayName")
    name = display_name.get("text") if isinstance(display_name, dict) else None
    return {
        "id": str(value.get("id") or ""),
        "name": str(name or value.get("formattedAddress") or "未命名地点"),
        "address": str(value.get("formattedAddress") or ""),
        "location": {"latitude": latitude, "longitude": longitude},
        "types": [str(item) for item in value.get("types") or []],
        "country_code": _country_code(value.get("addressComponents")),
    }


def _country_code(value: Any) -> str:
    for component in value if isinstance(value, list) else []:
        if not isinstance(component, dict) or "country" not in (component.get("types") or []):
            continue
        return str(component.get("shortText") or "").upper()
    return ""


def _validate_point(latitude: float, longitude: float) -> None:
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("point is outside the WGS-84 coordinate range")


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _read_json(request: Request, timeout_s: float) -> dict[str, Any]:
    try:
        with urlopen(request, timeout=timeout_s) as response:  # noqa: S310 - fixed HTTPS provider URL
            payload = json.load(response)
    except HTTPError as exc:
        detail = _http_error_detail(exc)
        raise RuntimeError(f"Google Places returned HTTP {exc.code}: {detail}") from exc
    except (TimeoutError, URLError, OSError) as exc:
        raise TransientProviderError(f"Google Places request failed: {_safe_reason(exc)}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Google Places returned an invalid JSON object")
    if isinstance(payload.get("error"), dict):
        raise RuntimeError(f"Google Places error: {payload['error'].get('message') or 'unknown provider error'}")
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


def _safe_reason(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None)
    return str(reason or exc.__class__.__name__)
