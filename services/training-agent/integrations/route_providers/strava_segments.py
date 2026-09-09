"""Fetch bounded Strava segment data for production route planning.

This tool intentionally does not fetch athlete activities or scrape public
tracks.  It only stores the documented, bounded Segment Explorer response.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_API_BASE_URL = "https://api-v3.strava.com"
COMPATIBLE_API_BASE_URL = "https://www.strava.com/api/v3"


class StravaSegmentNetworkError(RuntimeError):
    """A network/TLS failure where trying the compatible API hostname is safe."""


def explore_segments(
    bounds: str,
    access_token: str,
    *,
    base_url: str = DEFAULT_API_BASE_URL,
    timeout_s: float = 30.0,
    retry_attempts: int = 2,
) -> dict[str, Any]:
    """Return Strava's top segment sample in one geographic bounding box."""
    values = [float(value.strip()) for value in bounds.split(",")]
    if len(values) != 4:
        raise ValueError("bounds must be south,west,north,east")
    query = urlencode({"bounds": ",".join(str(value) for value in values), "activity_type": "riding"})
    selected_base_url = base_url.rstrip("/")
    try:
        payload = _fetch_segments(
            query, access_token, base_url=selected_base_url,
            timeout_s=timeout_s, retry_attempts=retry_attempts,
        )
    except StravaSegmentNetworkError:
        # Some WSL proxy configurations accept www.strava.com but reset the
        # TLS handshake for api-v3.strava.com. The endpoint is compatible; do
        # not apply this fallback for caller-specified custom API servers.
        if selected_base_url != DEFAULT_API_BASE_URL:
            raise
        selected_base_url = COMPATIBLE_API_BASE_URL
        payload = _fetch_segments(
            query, access_token, base_url=selected_base_url,
            timeout_s=timeout_s, retry_attempts=retry_attempts,
        )
    return {
        "schema_version": "strava_segment_sample.v1",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "bounds_wgs84": values,
        "source": "strava_segments_explore",
        "api_base_url": selected_base_url,
        "segment_count": len(payload.get("segments") or []),
        "segments": payload.get("segments") or [],
    }


def fetch_segment_detail(
    segment_id: int,
    access_token: str,
    *,
    base_url: str = DEFAULT_API_BASE_URL,
    timeout_s: float = 30.0,
    retry_attempts: int = 2,
) -> dict[str, Any]:
    """Fetch one public Segment detail, including its route polyline.

    Segment Explorer is useful for discovery but only includes endpoints.  A
    detail request is the bounded follow-up that turns one selected popular
    cycling segment into an actual route constraint.
    """
    if segment_id <= 0:
        raise ValueError("segment_id must be positive")
    selected_base_url = base_url.rstrip("/")
    try:
        payload = _fetch_segment_detail(
            segment_id, access_token, base_url=selected_base_url,
            timeout_s=timeout_s, retry_attempts=retry_attempts,
        )
    except StravaSegmentNetworkError:
        if selected_base_url != DEFAULT_API_BASE_URL:
            raise
        selected_base_url = COMPATIBLE_API_BASE_URL
        payload = _fetch_segment_detail(
            segment_id, access_token, base_url=selected_base_url,
            timeout_s=timeout_s, retry_attempts=retry_attempts,
        )
    return payload


def decode_polyline(value: str) -> list[list[float]]:
    """Decode a Google/Strava encoded polyline into GeoJSON lon/lat points."""
    coordinates: list[list[float]] = []
    index = latitude = longitude = 0
    while index < len(value):
        changes = []
        for _ in range(2):
            shift = result = 0
            while True:
                if index >= len(value):
                    raise ValueError("invalid encoded polyline")
                byte = ord(value[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            changes.append(~(result >> 1) if result & 1 else result >> 1)
        latitude += changes[0]
        longitude += changes[1]
        coordinates.append([longitude / 100_000, latitude / 100_000])
    if len(coordinates) < 2:
        raise ValueError("encoded polyline contains insufficient points")
    return coordinates


def segment_detail_feature(detail: dict[str, Any]) -> dict[str, Any]:
    """Normalize a fetched Strava Segment into the existing planner input."""
    polyline = ((detail.get("map") or {}).get("polyline") or "").strip()
    if not polyline:
        raise ValueError("Strava Segment detail has no route polyline")
    try:
        segment_id = int(detail["id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("Strava Segment detail has no valid id") from exc
    return {
        "type": "Feature",
        "properties": {
            "kind": "strava_segment",
            "id": segment_id,
            "name": str(detail.get("name") or f"Strava Segment {segment_id}"),
            "distance_m": float(detail.get("distance") or 0),
            "ascend_m": float(detail.get("total_elevation_gain") or 0),
            "average_grade": detail.get("average_grade"),
            "maximum_grade": detail.get("maximum_grade"),
            "climb_category": detail.get("climb_category"),
            "hazardous": bool(detail.get("hazardous")),
            "source": "strava_segment_detail",
        },
        "geometry": {"type": "LineString", "coordinates": decode_polyline(polyline)},
    }


def segment_details_feature_collection(details: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Create a small, inspectable planner input from selected Segment details."""
    features = [segment_detail_feature(item) for item in details]
    if not features:
        raise ValueError("at least one Strava Segment detail is required")
    return {
        "type": "FeatureCollection",
        "metadata": {
            "schema_version": "strava_segment_details_geojson.v1",
            "source": "strava_segment_detail",
            "segment_ids": [item["properties"]["id"] for item in features],
        },
        "features": features,
    }


def _fetch_segments(
    query: str, access_token: str, *, base_url: str, timeout_s: float, retry_attempts: int,
) -> dict[str, Any]:
    request = Request(
        f"{base_url}/segments/explore?{query}",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    return _read_json_with_retry(request, timeout_s=timeout_s, retry_attempts=retry_attempts)


def _fetch_segment_detail(
    segment_id: int, access_token: str, *, base_url: str, timeout_s: float, retry_attempts: int,
) -> dict[str, Any]:
    request = Request(
        f"{base_url}/segments/{segment_id}",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    return _read_json_with_retry(request, timeout_s=timeout_s, retry_attempts=retry_attempts)


def _read_json_with_retry(request: Request, *, timeout_s: float, retry_attempts: int) -> dict[str, Any]:
    """Retry only transient network/5xx failures; never weaken TLS validation."""
    attempts = max(1, int(retry_attempts))
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            with urlopen(request, timeout=timeout_s) as response:
                payload = json.load(response)
            if not isinstance(payload, dict):
                raise RuntimeError("Strava returned a non-object JSON response")
            return payload
        except HTTPError as exc:
            last_error = exc
            retryable = exc.code == 429 or 500 <= exc.code < 600
        except URLError as exc:
            last_error = exc
            retryable = True
        if not retryable or attempt == attempts - 1:
            break
        time.sleep(1 + attempt)
    assert last_error is not None
    error_type = StravaSegmentNetworkError if isinstance(last_error, URLError) else RuntimeError
    raise error_type(
        "Strava Segment Explorer request failed. "
        "Check the current network/TLS path or retry later; do not disable certificate validation."
    ) from last_error
