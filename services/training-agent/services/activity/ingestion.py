"""Canonical deterministic FIT ingestion and Rider-facing detail artifacts."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from services.activity.fit_loader import parse_activity_fit as parse_fit
from project_paths import resolve_project_path
from services.activity.catalog import upsert_activity_from_fit
from storage.repositories.activity import ActivityStore, file_content_key


DETAIL_ARTIFACT_TYPE = "activity_detail"
DETAIL_SCHEMA_VERSION = "activity_detail.v1"
SEMICIRCLES_TO_DEGREES = 180 / 2147483648


def ingest_fit_activity(
    fit_path: str | Path,
    *,
    activity_key: str | None = None,
    source: str = "manual",
    source_activity_id: str | None = None,
    name: str | None = None,
    max_points: int = 700,
    path: str | Path | None = None,
) -> dict[str, Any]:
    """Parse one immutable FIT once, persist identity/facts and cache UI detail."""
    resolved = resolve_project_path(fit_path)
    parsed = parse_fit(resolved)
    activity = upsert_activity_from_fit(
        resolved,
        activity_key=activity_key,
        source=source,
        source_activity_id=source_activity_id,
        name=name,
        path=path,
        parsed=parsed,
    )
    stable_key = str(activity.get("activity_key") or activity_key or "")
    if not stable_key:
        raise ValueError("FIT ingestion did not produce an activity ID")
    input_hash = file_content_key(resolved)
    store = ActivityStore(path)
    facts = store.get_facts(stable_key) or {}
    metrics = facts.get("metrics") if isinstance(facts.get("metrics"), dict) else {}
    detail = build_activity_detail_artifact(
        parsed, activity=activity, metrics=metrics, max_points=max_points,
    )
    store.save_artifact(
        stable_key,
        artifact_type=DETAIL_ARTIFACT_TYPE,
        schema_version=DETAIL_SCHEMA_VERSION,
        input_hash=input_hash,
        payload=detail,
    )
    return {
        "schema_version": "fit_ingestion.v1",
        "status": "completed",
        "activity": activity,
        "detail": detail,
        "input_hash": input_hash,
    }


def get_activity_detail(
    activity_key: str,
    *,
    max_points: int = 700,
    path: str | Path | None = None,
) -> dict[str, Any] | None:
    """Return a current cached detail artifact, rebuilding it from FIT when stale."""
    store = ActivityStore(path)
    activity = store.get_activity(activity_key)
    if activity is None:
        return None
    fit_path = activity.get("fit_path")
    if not fit_path:
        return {"schema_version": DETAIL_SCHEMA_VERSION, "activity": activity, "series": {"records": []}}
    resolved = resolve_project_path(str(fit_path))
    if not resolved.is_file():
        return {"schema_version": DETAIL_SCHEMA_VERSION, "activity": activity, "series": {"records": []}}
    input_hash = file_content_key(resolved)
    cached = store.get_artifact(activity_key, DETAIL_ARTIFACT_TYPE)
    if (
        cached
        and cached.get("schema_version") == DETAIL_SCHEMA_VERSION
        and cached.get("input_hash") == input_hash
    ):
        payload = cached.get("payload") if isinstance(cached.get("payload"), dict) else {}
        series = payload.get("series") if isinstance(payload.get("series"), dict) else {}
        sample_count = int(series.get("sample_count") or 0)
        original_count = int(series.get("original_record_count") or sample_count)
        requested_count = min(max(2, int(max_points)), original_count) if original_count else 0
        if sample_count >= requested_count:
            return _limit_detail_records(
                {**payload, "activity": activity},
                max_points=max_points,
            )
    parsed = parse_fit(resolved)
    facts = store.get_facts(activity_key) or {}
    metrics = facts.get("metrics") if isinstance(facts.get("metrics"), dict) else {}
    detail = build_activity_detail_artifact(
        parsed, activity=activity, metrics=metrics, max_points=max_points,
    )
    store.save_artifact(
        activity_key,
        artifact_type=DETAIL_ARTIFACT_TYPE,
        schema_version=DETAIL_SCHEMA_VERSION,
        input_hash=input_hash,
        payload=detail,
    )
    return detail


def _limit_detail_records(detail: dict[str, Any], *, max_points: int) -> dict[str, Any]:
    series = detail.get("series") if isinstance(detail.get("series"), dict) else {}
    records = [row for row in series.get("records") or [] if isinstance(row, dict)]
    sampled = _sample_records(records, max_points=max_points)
    if len(sampled) == len(records):
        return detail
    return {
        **detail,
        "series": {
            **series,
            "sample_count": len(sampled),
            "records": sampled,
        },
    }


def build_activity_detail_artifact(
    parsed: dict[str, Any],
    *,
    activity: dict[str, Any],
    metrics: dict[str, Any] | None = None,
    max_points: int = 700,
) -> dict[str, Any]:
    """Project raw FIT messages into a bounded, UI-neutral detail contract."""
    records = [row for row in parsed.get("records") or [] if isinstance(row, dict)]
    sampled = _sample_records(records, max_points=max_points)
    start = _timestamp(records[0].get("timestamp")) if records else None
    projected = [_project_record(row, start=start) for row in sampled]
    projected = [row for row in projected if row]
    training = parsed.get("training_metadata") if isinstance(parsed.get("training_metadata"), dict) else {}
    zones = training.get("zones_target") if isinstance(training.get("zones_target"), dict) else {}
    profile = training.get("user_profile") if isinstance(training.get("user_profile"), dict) else {}
    return {
        "schema_version": DETAIL_SCHEMA_VERSION,
        "activity": activity,
        "metrics": metrics or {},
        "settings": {
            "ftp": _number(zones.get("functional_threshold_power")),
            "resting_hr": _number(profile.get("resting_heart_rate")),
            "max_hr": _number(
                zones.get("max_heart_rate")
                or profile.get("default_max_biking_heart_rate")
                or profile.get("default_max_heart_rate")
            ),
            "mass_kg": _number(profile.get("weight")),
        },
        "series": {
            "original_record_count": len(records),
            "sample_count": len(projected),
            "records": projected,
        },
    }


def _sample_records(records: list[dict[str, Any]], *, max_points: int) -> list[dict[str, Any]]:
    limit = max(2, min(int(max_points), 2000))
    if len(records) <= limit:
        return records
    indices = [round(index * (len(records) - 1) / (limit - 1)) for index in range(limit)]
    return [records[index] for index in dict.fromkeys(indices)]


def _project_record(row: dict[str, Any], *, start: datetime | None) -> dict[str, Any]:
    timestamp = _timestamp(row.get("timestamp"))
    elapsed = (timestamp - start).total_seconds() if timestamp and start else None
    latitude = _semicircles(row.get("position_lat"))
    longitude = _semicircles(row.get("position_long"))
    return _compact({
        "elapsed_seconds": round(elapsed, 3) if elapsed is not None else None,
        "distance_km": _scaled(row.get("distance"), 0.001, 5),
        "power_w": _number(row.get("power")),
        "heart_rate_bpm": _number(row.get("heart_rate")),
        "cadence_rpm": _number(row.get("cadence")),
        "speed_kmh": _scaled(_first(row.get("enhanced_speed"), row.get("speed")), 3.6, 3),
        "elevation_m": _number(_first(row.get("enhanced_altitude"), row.get("altitude"))),
        "grade_percent": _number(row.get("grade")),
        "latitude": latitude,
        "longitude": longitude,
    })


def _timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _semicircles(value: Any) -> float | None:
    number = _number(value)
    return round(number * SEMICIRCLES_TO_DEGREES, 7) if number is not None else None


def _scaled(value: Any, scale: float, digits: int) -> float | None:
    number = _number(value)
    return round(number * scale, digits) if number is not None else None


def _first(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def _compact(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}
