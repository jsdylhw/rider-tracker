"""Google Places adapter shared by route planning and route narration."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import requests

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PHOTO_NAME_RE = re.compile(r"^places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_-]+$")
ROUTE_FIELD_MASK = ",".join((
    "places.id", "places.displayName", "places.formattedAddress", "places.location",
    "places.types", "places.addressComponents",
))
NARRATION_FIELD_MASK = ",".join((
    "places.id", "places.displayName", "places.formattedAddress", "places.location",
    "places.types", "places.primaryTypeDisplayName", "places.editorialSummary",
    "places.googleMapsUri", "places.photos",
))
GOOGLE_PLACES_FIELD_MASK = ROUTE_FIELD_MASK
JsonTransport = Callable[[Request, float], dict[str, Any]]


class GooglePlacesClient:
    def __init__(
        self,
        api_key: str,
        *,
        timeout_seconds: float = 20,
        timeout_s: float | None = None,
        base_url: str = SEARCH_URL,
        retries: int = 2,
        retry_delay_s: float = 0.4,
        transport: JsonTransport | None = None,
    ) -> None:
        if not str(api_key or "").strip() or str(api_key).startswith("replace-with-"):
            raise ValueError("google.api_key is not configured")
        self.api_key = str(api_key).strip()
        self.timeout_seconds = float(timeout_s if timeout_s is not None else timeout_seconds)
        self.base_url = base_url
        self.retries = max(0, int(retries))
        self.retry_delay_s = max(0.0, float(retry_delay_s))
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
        """Search route anchors and return the stable route-planning shape."""
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
                },
            }
        response = self._send(payload, field_mask=ROUTE_FIELD_MASK)
        places = []
        for raw_place in response.get("places") or []:
            normalized = _normalize_route_place(raw_place)
            if normalized is not None:
                places.append(normalized)
        return {
            "schema_version": "place_search.v1",
            "provider": "google_places",
            "coordinate_system": "wgs84",
            "query": text_query,
            "places": places,
        }

    def search_near_route_point(
        self, *, query: str, latitude: float, longitude: float, limit: int = 4,
    ) -> list[dict[str, Any]]:
        payload = {
            "textQuery": query,
            "pageSize": max(1, min(int(limit), 8)),
            "languageCode": "zh-CN",
            "locationBias": {
                "circle": {
                    "center": {"latitude": latitude, "longitude": longitude},
                    "radius": 5000,
                }
            },
        }
        data = self._send(payload, field_mask=NARRATION_FIELD_MASK)
        return [_normalize_place(item) for item in data.get("places") or [] if isinstance(item, dict)]

    def _send(self, payload: dict[str, Any], *, field_mask: str) -> dict[str, Any]:
        request = Request(
            self.base_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": field_mask,
            },
            method="POST",
        )
        for attempt in range(self.retries + 1):
            try:
                return self.transport(request, self.timeout_seconds)
            except TransientProviderError:
                if attempt >= self.retries:
                    raise
                time.sleep(self.retry_delay_s * (attempt + 1))
        raise RuntimeError("Google Places retry loop ended unexpectedly")  # pragma: no cover

    def get_photo(self, *, photo_name: str, max_width: int = 720) -> tuple[bytes, str]:
        """Fetch one bounded Place Photo without exposing the API key to Rider."""
        name = str(photo_name or "").strip()
        if not PHOTO_NAME_RE.fullmatch(name):
            raise ValueError("invalid Google Place photo name")
        width = max(160, min(int(max_width), 1200))
        url = f"https://places.googleapis.com/v1/{name}/media"
        response = None
        for attempt in range(2):
            try:
                response = requests.get(
                    url,
                    params={"maxWidthPx": width, "key": self.api_key},
                    timeout=self.timeout_seconds,
                )
            except requests.RequestException as exc:
                if attempt == 0:
                    continue
                # Do not interpolate the exception: requests may include the
                # key-bearing upstream URL in its diagnostic string.
                raise RuntimeError("Google Place Photo network request failed") from exc
            if response.status_code < 500 or attempt == 1:
                break
        if response is None:
            raise RuntimeError("Google Place Photo request failed")
        if not response.ok:
            raise RuntimeError(f"Google Place Photo HTTP {response.status_code}")
        content_type = str(response.headers.get("content-type") or "image/jpeg").split(";", 1)[0]
        if not content_type.startswith("image/"):
            raise RuntimeError(f"Google Place Photo returned {content_type}")
        payload = response.content
        if len(payload) > 5_000_000:
            raise RuntimeError("Google Place Photo exceeds 5 MB")
        return payload, content_type


def _normalize_place(place: dict[str, Any]) -> dict[str, Any]:
    display = place.get("displayName") if isinstance(place.get("displayName"), dict) else {}
    primary = place.get("primaryTypeDisplayName") if isinstance(place.get("primaryTypeDisplayName"), dict) else {}
    editorial = place.get("editorialSummary") if isinstance(place.get("editorialSummary"), dict) else {}
    location = place.get("location") if isinstance(place.get("location"), dict) else {}
    return {
        "source_id": f"google_place:{place.get('id') or ''}",
        "name": str(display.get("text") or place.get("formattedAddress") or "未命名地点"),
        "address": str(place.get("formattedAddress") or ""),
        "primary_type": str(primary.get("text") or ""),
        "types": [str(value) for value in place.get("types") or []],
        "summary": str(editorial.get("text") or ""),
        "latitude": location.get("latitude"),
        "longitude": location.get("longitude"),
        "url": str(place.get("googleMapsUri") or ""),
        "photos": [
            normalized
            for item in (place.get("photos") or [])[:3]
            if isinstance(item, dict) and (normalized := _normalize_photo(item)) is not None
        ],
    }


def _normalize_route_place(value: Any) -> dict[str, Any] | None:
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


def _normalize_photo(photo: dict[str, Any]) -> dict[str, Any] | None:
    name = str(photo.get("name") or "").strip()
    if not PHOTO_NAME_RE.fullmatch(name):
        return None
    attributions = []
    for raw in photo.get("authorAttributions") or []:
        if not isinstance(raw, dict):
            continue
        attributions.append({
            "display_name": str(raw.get("displayName") or "").strip(),
            "uri": str(raw.get("uri") or "").strip(),
            "photo_uri": str(raw.get("photoUri") or "").strip(),
        })
    return {
        "photo_name": name,
        "width": _optional_positive_int(photo.get("widthPx")),
        "height": _optional_positive_int(photo.get("heightPx")),
        "author_attributions": attributions,
    }


def _optional_positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


class TransientProviderError(RuntimeError):
    """Retryable transport failure before a valid provider response."""


def _read_json(request: Request, timeout_s: float) -> dict[str, Any]:
    try:
        with urlopen(request, timeout=timeout_s) as response:  # noqa: S310 - fixed HTTPS provider URL
            payload = json.load(response)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Google Places HTTP {exc.code}: {detail}") from exc
    except (TimeoutError, URLError, OSError) as exc:
        reason = getattr(exc, "reason", None)
        raise TransientProviderError(f"Google Places request failed: {reason or exc.__class__.__name__}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Google Places returned an invalid JSON object")
    if isinstance(payload.get("error"), dict):
        raise RuntimeError(f"Google Places error: {payload['error'].get('message') or 'unknown provider error'}")
    return payload
