"""Deterministic archive service for completed Rider sessions without a FIT."""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from storage.repositories.activity import ActivityStore


def archive_rider_session(
    session: dict[str, Any],
    *,
    name: Any = None,
    sport_type: Any = None,
    path: str | Path | None = None,
) -> dict[str, Any]:
    """Archive a completed browser session and its route link in one transaction.

    This is the small, non-FIT fallback used when FIT encoding or ingestion did
    not complete.  It deliberately does not parse FIT data or invoke an LLM.
    """
    activity = normalize_rider_session(session, name=name, sport_type=sport_type)
    return ActivityStore(path).archive_rider_session(activity, raw_session=session)


def normalize_rider_session(
    session: dict[str, Any],
    *,
    name: Any = None,
    sport_type: Any = None,
    now: str | None = None,
) -> dict[str, Any]:
    """Preserve the former Node session-to-activity compatibility contract."""
    if not isinstance(session, dict):
        raise ValueError("Rider session payload is required.")

    summary = _mapping(session.get("summary"))
    metrics = _mapping(summary.get("metrics"))
    ride = _mapping(metrics.get("ride"))
    power = _mapping(metrics.get("power"))
    heart_rate = _mapping(metrics.get("heartRate"))
    load = _mapping(metrics.get("load"))
    export_metadata = _mapping(session.get("exportMetadata"))
    archived_at = now or datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
    started_at = session.get("startedAt") or session.get("createdAt") or archived_at
    records = session.get("records") if isinstance(session.get("records"), list) else []
    activity_id = (
        _non_empty_text(session.get("activityId"), 128)
        or _non_empty_text(session.get("id"), 128)
        or _stable_session_id(session, started_at, records)
    )
    has_gps_track = bool(session.get("hasGpsTrack")) or _session_has_gps_track(records)
    normalized_name = _normalized_text(
        name or export_metadata.get("activityName") or session.get("name"),
        fallback="Rider Tracker Virtual Ride",
        maximum=120,
    )
    normalized_sport = _non_empty_text(sport_type, 64) or _infer_sport_type(
        export_metadata=export_metadata,
        has_gps_track=has_gps_track,
    )
    source = _non_empty_text(session.get("source"), 64) or "rider-tracker"
    route = _route_link(session, ride)

    return {
        "id": activity_id,
        "source": source,
        "sport_type": normalized_sport,
        "name": normalized_name,
        "started_at": str(started_at),
        "finished_at": _optional_text(session.get("finishedAt") or session.get("completedAt")),
        "elapsed_seconds": _finite(ride.get("elapsedSeconds"), summary.get("elapsedSeconds")),
        "distance_km": _finite(ride.get("distanceKm"), summary.get("distanceKm")),
        "ascent_meters": _finite(ride.get("ascentMeters"), summary.get("ascentMeters")),
        "average_power": _finite(power.get("averageWatts"), summary.get("averagePower")),
        "normalized_power": _finite(power.get("normalizedPowerWatts")),
        "average_hr": _finite(heart_rate.get("averageBpm"), summary.get("averageHeartRate")),
        "estimated_tss": _finite(load.get("estimatedTss")),
        "has_gps_track": has_gps_track,
        "saved_route_id": route["saved_route_id"],
        "route_start_distance_meters": route["start_distance_meters"],
        "route_end_distance_meters": route["end_distance_meters"],
        "created_at": archived_at,
        "updated_at": archived_at,
    }


def _route_link(session: dict[str, Any], ride: dict[str, Any]) -> dict[str, Any]:
    route = _mapping(session.get("route"))
    saved_route_id = _non_empty_text(route.get("savedRouteId"), 128)
    if not saved_route_id:
        return {
            "saved_route_id": None,
            "start_distance_meters": None,
            "end_distance_meters": None,
        }
    continuation = _mapping(route.get("continuation"))
    start = _finite_or_zero(
        continuation.get("startDistanceMeters"),
        route.get("savedRouteResumeDistanceMeters"),
    )
    distance_km = _finite_or_zero(ride.get("distanceKm"), _mapping(session.get("summary")).get("distanceKm"))
    return {
        "saved_route_id": saved_route_id,
        "start_distance_meters": start,
        "end_distance_meters": start + distance_km * 1000,
    }


def _stable_session_id(session: dict[str, Any], started_at: Any, records: list[Any]) -> str:
    summary = _mapping(session.get("summary"))
    ride = _mapping(_mapping(summary.get("metrics")).get("ride"))
    distance_km = ride.get("distanceKm")
    if distance_km is None:
        distance_km = summary.get("distanceKm")
    fingerprint = ":".join((
        "rider-tracker",
        _javascript_text(started_at),
        _javascript_text(session.get("finishedAt")),
        _javascript_text(distance_km),
        str(len(records)),
    ))
    return f"rt-{hashlib.sha1(fingerprint.encode('utf-8')).hexdigest()[:16]}"


def _session_has_gps_track(records: list[Any]) -> bool:
    for record in records:
        if not isinstance(record, dict):
            continue
        if _is_js_finite_number(record.get("lat")) or _is_js_finite_number(record.get("latitude")):
            return True
        if _is_js_finite_number(record.get("positionLat")) and _is_js_finite_number(record.get("positionLong")):
            return True
        if isinstance(record.get("latlng"), list):
            return True
    return False


def _infer_sport_type(*, export_metadata: dict[str, Any], has_gps_track: bool) -> str:
    if export_metadata.get("markVirtualActivity") is False and has_gps_track:
        return "Ride"
    return "VirtualRide"


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _finite(*values: Any) -> float | None:
    for value in values:
        if value is None or isinstance(value, bool):
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            return number
    return None


def _finite_or_zero(*values: Any) -> float:
    value = _finite(*values)
    return value if value is not None else 0.0


def _is_js_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _normalized_text(value: Any, *, fallback: str, maximum: int) -> str:
    normalized = _non_empty_text(value, maximum)
    return normalized if normalized else fallback[:maximum]


def _non_empty_text(value: Any, maximum: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized[:maximum] if normalized else None


def _optional_text(value: Any) -> str | None:
    return str(value) if value not in (None, "") else None


def _javascript_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)
