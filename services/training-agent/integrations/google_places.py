"""Minimal production Google Places adapter for route narration preparation."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import requests

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PHOTO_NAME_RE = re.compile(r"^places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_-]+$")
FIELD_MASK = ",".join((
    "places.id", "places.displayName", "places.formattedAddress", "places.location",
    "places.types", "places.primaryTypeDisplayName", "places.editorialSummary",
    "places.googleMapsUri", "places.photos",
))


class GooglePlacesClient:
    def __init__(self, api_key: str, *, timeout_seconds: float = 20) -> None:
        if not str(api_key or "").strip():
            raise ValueError("google.api_key is not configured")
        self.api_key = str(api_key).strip()
        self.timeout_seconds = timeout_seconds

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
        request = Request(
            SEARCH_URL,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": FIELD_MASK,
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310
                data = json.load(response)
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"Google Places HTTP {exc.code}: {detail}") from exc
        except (TimeoutError, URLError, OSError) as exc:
            raise RuntimeError(f"Google Places request failed: {exc}") from exc
        return [_normalize_place(item) for item in data.get("places") or [] if isinstance(item, dict)]

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
