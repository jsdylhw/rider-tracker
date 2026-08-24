"""SQLite-backed activity catalogue used by selection and Garmin sync."""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from typing import Any

from domain.analysis.artifacts import get_index_load_label
from fit.analysis.stats import _meters_to_km, _seconds_to_minutes, prune_empty_values
from storage.repositories.activity import ActivityStore, entry_from_fit_summary, file_content_key
from services.activity.fit_loader import parse_activity_fit as parse_fit
from fit.analysis.features import build_activity_features
from fit.analysis.metrics import build_activity_metrics
from project_paths import project_relative_or_absolute, resolve_project_path

def load_activity_index(path: str | Path | None = None) -> dict[str, Any]:
    """Return the catalogue shape expected by existing selection handlers."""
    rows = ActivityStore(path).list_activity_entries()
    return {
        "schema_version": "activity_catalog.v1",
        "storage": "sqlite",
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "activities": _with_activity_indices(rows),
    }


def replace_activity_entries(entries: list[dict[str, Any]], *, path: str | Path | None = None) -> None:
    """Replace a catalogue in an explicit SQLite database, primarily for tests."""
    ActivityStore(path).replace_activities(entries)


def upsert_activity_from_fit(
    fit_path: str | Path,
    *,
    activity_key: str | None = None,
    source: str = "manual",
    source_activity_id: str | None = None,
    name: str | None = None,
    path: str | Path | None = None,
    parsed: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """解析 FIT 并写入/更新活动索引."""
    fit = resolve_project_path(fit_path)
    parsed_fit = parsed if isinstance(parsed, dict) else parse_fit(fit)
    summary = parsed_fit.get("summary") or {}
    store = ActivityStore(path)
    stored_fit_path = project_relative_or_absolute(fit)
    existing = store.find_activity_identity(
        fit_path=stored_fit_path,
        source=source,
        source_activity_id=source_activity_id,
    )
    stable_activity_key = activity_key or (existing or {}).get("activity_key")
    entry = entry_from_fit_summary(
        fit,
        summary,
        source=source,
        source_activity_id=source_activity_id,
        activity_key=str(stable_activity_key) if stable_activity_key else None,
    )
    entry["name"] = str(name or (existing or {}).get("name") or entry["file_name"])
    entry["has_gps_track"] = any(
        row.get("position_lat") is not None and row.get("position_long") is not None
        for row in parsed_fit.get("records") or []
        if isinstance(row, dict)
    )
    metrics = build_activity_metrics(
        parsed_fit,
        activity_key=str(entry["activity_key"]),
        fit_path=entry.get("fit_path"),
    )
    features = build_activity_features(
        parsed_fit,
        activity_key=str(entry["activity_key"]),
        fit_path=entry.get("fit_path"),
    )
    scale = metrics.get("scale") if isinstance(metrics.get("scale"), dict) else {}
    power = metrics.get("power") if isinstance(metrics.get("power"), dict) else {}
    heart_rate = metrics.get("heart_rate") if isinstance(metrics.get("heart_rate"), dict) else {}
    power_stress = (
        metrics.get("load", {}).get("power_stress", {})
        if isinstance(metrics.get("load"), dict)
        else {}
    )
    entry.update(prune_empty_values({
        "ascent_meters": scale.get("total_ascent_m"),
        "average_power": power.get("avg_power_w"),
        "normalized_power": power.get("normalized_power_w"),
        "average_hr": heart_rate.get("avg_hr_bpm"),
        "estimated_tss": power_stress.get("tss") if isinstance(power_stress, dict) else None,
    }))
    stored = store.upsert_activity(entry)
    activity_key = str(stored.get("activity_key") or entry["activity_key"])
    facts = store.save_facts(activity_key, metrics=metrics, features=features)
    return {**stored, "facts_schema_version": facts["schema_version"], "facts_revision": facts["revision"]}


def persist_activity_facts(
    parsed: dict[str, Any],
    *,
    activity_key: str,
    fit_path: str | None,
    path: str | Path | None = None,
) -> dict[str, Any]:
    """Save deterministic import-time facts after the matching activity exists."""
    metrics = build_activity_metrics(parsed, activity_key=activity_key, fit_path=fit_path)
    features = build_activity_features(parsed, activity_key=activity_key, fit_path=fit_path)
    return ActivityStore(path).save_facts(activity_key, metrics=metrics, features=features)


def upsert_activity_entry(entry: dict[str, Any], *, path: str | Path | None = None) -> dict[str, Any]:
    return prune_empty_values(ActivityStore(path).upsert_activity(entry))


def rebuild_activity_index(
    roots: list[str | Path] | None = None,
    *,
    path: str | Path | None = None,
) -> dict[str, Any]:
    """扫描本地 FIT 和 summary,重建活动索引."""
    store = ActivityStore(path)
    store.clear()

    for fit in _iter_fit_files(roots):
        try:
            upsert_activity_from_fit(fit, path=path)
        except Exception:
            continue
    return load_activity_index(path)


def list_activities(
    *,
    limit: int = 20,
    sport_type: str | None = None,
    time_of_day: str | None = None,
    order: str = "latest",
    path: str | Path | None = None,
) -> dict[str, Any]:
    rows = _filter_rows(
        load_activity_index(path).get("activities") or [],
        sport_type=sport_type,
        time_of_day=time_of_day,
    )
    order_key = _activity_order_key(order)
    if order_key == "earliest":
        rows = rows[: max(1, int(limit))] if limit else rows
    else:
        rows = rows[-max(1, int(limit)) :] if limit else rows
        rows = list(reversed(rows))
    return {
        "schema_version": "activity_list.v1",
        "count": len(rows),
        "order": order_key,
        "time_of_day": _normalize_time_of_day(time_of_day),
        "activities": [_compact_activity(row) for row in rows],
    }


def resolve_activity(
    *,
    activity_key: str | None = None,
    activity_index: int | str | None = None,
    date_local: str | None = None,
    name: str | None = None,
    sport_type: str | None = None,
    time_of_day: str | None = None,
    match: str = "latest",
    path: str | Path | None = None,
) -> dict[str, Any]:
    rows = load_activity_index(path).get("activities") or []
    rows = _filter_rows(rows, sport_type=sport_type, time_of_day=time_of_day)
    if activity_key:
        rows = [row for row in rows if str(row.get("activity_key")) == str(activity_key)]
    if activity_index is not None:
        try:
            wanted_index = int(activity_index)
        except (TypeError, ValueError):
            rows = []
        else:
            rows = [row for row in rows if row.get("activity_index") == wanted_index]
    if date_local:
        rows = [row for row in rows if row.get("date_local") == date_local]
    if name:
        needle = _normalize_text(name)
        rows = [
            row for row in rows
            if needle in _normalize_text(row.get("file_name") or "")
            or needle in _normalize_text(Path(str(row.get("fit_path") or "")).stem)
        ]

    if not rows:
        return {"schema_version": "activity_resolve.v1", "matched_count": 0, "activity": None, "candidates": []}

    chosen = rows[0] if _activity_order_key(match) == "earliest" else rows[-1]
    return {
        "schema_version": "activity_resolve.v1",
        "matched_count": len(rows),
        "activity": _compact_activity(chosen),
        "candidates": [_compact_activity(row) for row in rows[-10:]],
    }


def get_activities_in_range(
    *,
    start_date: str,
    end_date: str,
    sport_type: str | None = None,
    time_of_day: str | None = None,
    path: str | Path | None = None,
) -> dict[str, Any]:
    rows = load_activity_index(path).get("activities") or []
    rows = _filter_rows(rows, sport_type=sport_type, time_of_day=time_of_day)
    rows = [
        row for row in rows
        if row.get("date_local") and start_date <= str(row.get("date_local")) <= end_date
    ]
    total_duration_s = sum(float(row.get("duration_s") or 0) for row in rows)
    total_distance_m = sum(float(row.get("distance_m") or 0) for row in rows)
    return {
        "schema_version": "activity_range.v1",
        "start_date": start_date,
        "end_date": end_date,
        "sport_type": sport_type,
        "time_of_day": _normalize_time_of_day(time_of_day),
        "count": len(rows),
        "totals": {
            "duration_min": _seconds_to_minutes(total_duration_s),
            "distance_km": _meters_to_km(total_distance_m),
        },
        "activities": [_compact_activity(row) for row in rows],
    }


def _compact_activity(row: dict[str, Any]) -> dict[str, Any]:
    return prune_empty_values({
        "activity_key": row.get("activity_key"),
        "activity_index": row.get("activity_index"),
        "file_name": row.get("file_name"),
        "fit_path": row.get("fit_path"),
        "sport_type": row.get("sport_type"),
        "sub_sport": row.get("sub_sport"),
        "start_time_local": row.get("start_time_local"),
        "date_local": row.get("date_local"),
        "duration_min": row.get("duration_min") or _seconds_to_minutes(row.get("duration_s")),
        "distance_km": row.get("distance_km") or _meters_to_km(row.get("distance_m")),
        "source": row.get("source"),
        "has_summary": row.get("has_summary"),
        "has_strava_summary": row.get("has_strava_summary"),
        "strava_activity_id": row.get("strava_activity_id"),
        "summary_label": row.get("summary_label"),
        "main_stimulus": row.get("main_stimulus"),
        "load_label": get_index_load_label(row),
        "summary_schema_version": row.get("summary_schema_version"),
    })


def _iter_fit_files(roots: list[str | Path] | None = None) -> list[Path]:
    scan_roots = [Path(root) for root in roots] if roots else [
        Path("data") / "fit",
        Path("garmin_cn_fit_files"),
        Path.cwd(),
    ]
    files: list[Path] = []
    for root in scan_roots:
        if root.exists():
            files.extend(path for path in root.glob("*.fit") if path.is_file())
    return sorted(set(path.resolve() for path in files))


def _filter_rows(
    rows: list[dict[str, Any]],
    *,
    sport_type: str | None = None,
    time_of_day: str | None = None,
) -> list[dict[str, Any]]:
    indexed_rows = _with_activity_indices(rows)
    filtered = indexed_rows
    normalized_sport_type = _canonical_sport_type(sport_type)
    if normalized_sport_type:
        filtered = [
            row for row in filtered
            if _canonical_sport_type(row.get("sport_type")) == normalized_sport_type
        ]
    normalized_time_of_day = _normalize_time_of_day(time_of_day)
    if normalized_time_of_day:
        filtered = [row for row in filtered if _matches_time_of_day(row, normalized_time_of_day)]
    return sorted(filtered, key=lambda row: row.get("start_time_local") or "")


def _normalize_time_of_day(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    aliases = {
        "morning": "morning", "上午": "morning", "早上": "morning", "清晨": "morning",
        "afternoon": "afternoon", "下午": "afternoon",
        "evening": "evening", "傍晚": "evening", "晚上": "evening",
        "night": "night", "夜间": "night", "深夜": "night",
    }
    return aliases.get(text)


def _canonical_sport_type(value: Any) -> str | None:
    """Accept user/LLM labels without leaking Garmin's display names into lookup."""
    text = "".join(str(value or "").strip().lower().split())
    aliases = {
        "cycling": "cycling", "cycle": "cycling", "ride": "cycling", "bike": "cycling",
        "biking": "cycling", "骑行": "cycling", "单车": "cycling", "自行车": "cycling", "公路骑行": "cycling",
        "running": "running", "run": "running", "跑步": "running",
        "walking": "walking", "walk": "walking", "徒步": "walking", "hiking": "walking", "hike": "walking",
    }
    return aliases.get(text, text or None)


def _matches_time_of_day(row: dict[str, Any], time_of_day: str) -> bool:
    value = str(row.get("start_time_local") or "")
    try:
        hour = datetime.fromisoformat(value).hour
    except ValueError:
        return False
    if time_of_day == "morning":
        return 4 <= hour < 12
    if time_of_day == "afternoon":
        return 12 <= hour < 18
    if time_of_day == "evening":
        return 18 <= hour < 22
    return hour >= 22 or hour < 4


def _with_activity_indices(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sorted_rows = sorted(rows, key=lambda row: (row.get("start_time_local") or "", row.get("file_name") or ""))
    # 只保存一个按时间正序的序号:最早为 1,最后一个就是最大序号.
    return [
        {
            **row,
            "activity_index": index,
        }
        for index, row in enumerate(sorted_rows, start=1)
    ]


def _activity_order_key(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"earliest", "oldest", "first", "chronological", "asc", "ascending"}:
        return "earliest"
    return "latest"


def _activity_key(path: Path) -> str:
    return file_content_key(path)


def _date_part(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        return None


def _normalize_text(value: Any) -> str:
    return "".join(str(value or "").lower().split())
