"""Minimal production Google Places adapter for route narration preparation."""

from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
FIELD_MASK = ",".join((
    "places.id", "places.displayName", "places.formattedAddress", "places.location",
    "places.types", "places.primaryTypeDisplayName", "places.editorialSummary",
    "places.googleMapsUri",
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
    }
