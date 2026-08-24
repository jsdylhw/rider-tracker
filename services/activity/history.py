"""Deterministic history aggregation over selected activities."""

from __future__ import annotations

import calendar
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median
from typing import Any, Iterable

from services.activity.reporting import read_activity_report
from fit.analysis.metrics import build_activity_metrics
from domain.analysis.artifacts import (
    get_tss,
    get_tss_source,
    summary_schema_version,
)
from fit.parser import parse_fit
from storage.repositories.activity import ActivityStore


GROUP_BY_VALUES = {"day", "week", "month"}


def calculate_history_metrics(
    activities: Iterable[dict[str, Any]],
    *,
    scope: dict[str, Any] | None = None,
    group_by: str = "week",
    name: str = "calculate_history_metrics",
) -> dict[str, Any]:
    """Calculate time-series facts without asking an LLM to do arithmetic."""
    if group_by not in GROUP_BY_VALUES:
        return {
            "error": "invalid_group_by",
            "message": "group_by must be one of: day, week, month.",
        }

    raw_selected = [item for item in activities if isinstance(item, dict)]
    selected = _deduplicate_activities(raw_selected)
    if not selected:
        return {
            "error": "missing_selected_activities",
            "message": "calculate_history_metrics requires selected activities.",
        }

    loaded: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    source_counts: Counter[str] = Counter()
    for activity in selected:
        metrics, source, error = load_activity_metrics(activity)
        if metrics is None:
            missing.append({
                "activity_key": activity.get("activity_key"),
                "fit_path": activity.get("fit_path"),
                "error": error,
            })
            continue
        start = _metric_start(metrics, activity)
        if start is None:
            missing.append({
                "activity_key": activity.get("activity_key"),
                "error": "missing_start_time_local",
            })
            continue
        source_counts[source] += 1
        loaded.append({
            "activity_key": metrics.get("activity_key") or activity.get("activity_key"),
            "start_time_local": start.isoformat(),
            "source": source,
            "metrics": metrics,
        })

    if not loaded:
        return {
            "error": "missing_activity_metrics",
            "message": "No selected activity has usable structured metrics or FIT data.",
            "missing": missing,
        }

    loaded.sort(key=lambda item: item["start_time_local"])
    periods = _build_periods(loaded, group_by=group_by)
    overall = _aggregate_rows(loaded)
    thresholds = sorted({
        value
        for row in loaded
        if (value := _number(_section(row["metrics"], "power").get("threshold_power_w"))) is not None
    })
    tss_sources = sorted({
        str(value)
        for row in loaded
        if (value := get_tss_source(row["metrics"])) not in {None, "", "unavailable"}
    })

    result = {
        "schema_version": "training_history_metrics.v1",
        "scope": scope or {},
        "group_by": group_by,
        "coverage": {
            "selected_activity_count": len(selected),
            "duplicate_activity_count": len(raw_selected) - len(selected),
            "included_activity_count": len(loaded),
            "missing_activity_count": len(missing),
            "source_counts": dict(sorted(source_counts.items())),
            "metric_counts": overall.pop("metric_counts"),
            "missing_metrics": _missing_metric_names(loaded),
        },
        "date_range": {
            "start": loaded[0]["start_time_local"][:10],
            "end": loaded[-1]["start_time_local"][:10],
        },
        "overall": overall,
        "periods": periods,
        "comparison": _compare_latest_periods(periods),
        "consistency": {
            "power_thresholds_w": thresholds,
            "tss_sources": tss_sources,
            "comparable_power_load": len(thresholds) <= 1 and len(tss_sources) <= 1,
            "threshold_timeline": _threshold_timeline(loaded),
        },
        "activities": [
            {
                "activity_key": row["activity_key"],
                "start_time_local": row["start_time_local"],
                "sport_type": _section(row["metrics"], "identity").get("sport_type"),
                "source": row["source"],
            }
            for row in loaded
        ],
        "missing": missing,
    }
    return {"step": name, "status": "completed", "result": result}


def load_activity_metrics(activity: dict[str, Any]) -> tuple[dict[str, Any] | None, str, str | None]:
    """Load imported metrics first, retaining legacy report/FIT fallbacks."""
    activity_key = str(activity.get("activity_key") or "")
    if activity_key:
        facts = ActivityStore().get_facts(activity_key)
        metrics = facts.get("metrics") if isinstance(facts, dict) else None
        if isinstance(metrics, dict) and metrics.get("schema_version") == "activity_metrics.v2":
            return metrics, "stored_facts_v1", None

    summary, summary_error = read_activity_report(activity)
    if summary is not None:
        metrics = summary.get("activity_metrics")
        if (
            isinstance(metrics, dict)
            and metrics.get("schema_version") == "activity_metrics.v2"
            and summary_schema_version(summary) == "llm_fit_file_analysis.v2"
        ):
            return metrics, "stored_report_v2", None

    fit_path = _resolve_fit_path(activity, summary)
    if fit_path is not None:
        try:
            parsed = parse_fit(fit_path)
            summary_key = summary.get("activity_key") if summary else None
            metrics = build_activity_metrics(
                parsed,
                activity_key=str(activity.get("activity_key") or summary_key or "") or None,
                fit_path=str(fit_path),
            )
        except Exception as exc:
            return None, "", f"fit_parse_failed: {type(exc).__name__}: {exc}"
        return metrics, "fit_fallback", None

    basic = _basic_metrics_fallback(activity, summary)
    if basic is not None:
        return basic, "index_fallback", None
    return None, "", summary_error or "missing_summary_and_fit"


def _basic_metrics_fallback(
    activity: dict[str, Any], summary: dict[str, Any] | None,
) -> dict[str, Any] | None:
    summary = summary or {}
    fit_summary = _section(summary, "fit_summary")
    start = (
        fit_summary.get("start_time_local")
        or activity.get("start_time_local")
    )
    duration_min = _first_number(activity.get("duration_min"))
    distance_km = _first_number(activity.get("distance_km"))
    if start is None or (duration_min is None and distance_km is None):
        return None
    return {
        "schema_version": "activity_metrics.v2",
        "activity_key": summary.get("activity_key") or activity.get("activity_key"),
        "identity": {
            "sport_type": fit_summary.get("sport_type") or activity.get("sport_type"),
            "sub_sport": fit_summary.get("sub_sport") or activity.get("sub_sport"),
            "start_time_local": start,
        },
        "scale": {"duration_min": duration_min, "distance_km": distance_km},
        "power": {"available": False},
        "heart_rate": {"available": False},
        "cadence": {"available": False},
        "performance": {"speed_available": False, "pace_available": False},
        "load": {
            "power_stress": {
                "available": False,
                "method": "unavailable",
                "tss": None,
                "source": "unavailable",
            },
            "garmin": {"source": "unavailable"},
        },
        "data_quality": {},
    }


def _resolve_fit_path(activity: dict[str, Any], summary: dict[str, Any] | None) -> Path | None:
    candidates = [activity.get("fit_path")]
    if summary:
        candidates.append(summary.get("fit_path"))
    for value in candidates:
        if not value:
            continue
        path = Path(str(value)).expanduser()
        if path.exists() and path.is_file():
            return path
        name = str(value).replace("\\", "/").split("/")[-1]
        for directory in (Path("garmin_cn_fit_files"), Path("fit_files")):
            fallback = directory / name
            if fallback.exists() and fallback.is_file():
                return fallback
    return None


def _build_periods(rows: list[dict[str, Any]], *, group_by: str) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    bounds: dict[str, tuple[date, date]] = {}
    for row in rows:
        started = datetime.fromisoformat(row["start_time_local"])
        key, start, end = _period_identity(started.date(), group_by)
        groups.setdefault(key, []).append(row)
        bounds[key] = (start, end)

    periods: list[dict[str, Any]] = []
    for key in sorted(groups):
        aggregate = _aggregate_rows(groups[key])
        start, end = bounds[key]
        periods.append({
            "period": key,
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            **aggregate,
        })
    return periods


def _aggregate_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    durations = [
        value for row in rows
        if (value := _number(_section(row["metrics"], "scale").get("duration_min"))) is not None
    ]
    totals = {
        "duration_min": _sum_metric(rows, "scale", "duration_min"),
        "distance_km": _sum_metric(rows, "scale", "distance_km"),
        "total_ascent_m": _sum_metric(rows, "scale", "total_ascent_m"),
        "calories": _sum_metric(rows, "scale", "calories"),
        "tss": _sum_tss(rows),
    }
    weighted = {
        "avg_power_w": _weighted_metric(rows, "power", "avg_power_w", weight=("scale", "duration_min")),
        "normalized_power_w": _weighted_metric(rows, "power", "normalized_power_w", weight=("scale", "duration_min")),
        "intensity_factor": _weighted_metric(rows, "power", "intensity_factor", weight=("scale", "duration_min"), digits=3),
        "avg_hr_bpm": _weighted_metric(rows, "heart_rate", "avg_hr_bpm", weight=("scale", "duration_min")),
        "avg_cadence": _weighted_metric(rows, "cadence", "avg", weight=("scale", "duration_min")),
        "avg_speed_kmh": _weighted_metric(rows, "performance", "avg_speed_kmh", weight=("scale", "duration_min")),
        "avg_pace_s_per_km": _weighted_metric(rows, "performance", "avg_pace_s_per_km", weight=("scale", "distance_km")),
    }
    best = {
        "max_power_w": _extreme_metric(rows, "power", "max_power_w", maximum=True),
        "max_speed_kmh": _extreme_metric(rows, "performance", "max_speed_kmh", maximum=True),
        "fastest_pace_s_per_km": _extreme_metric(rows, "performance", "fastest_pace_s_per_km", maximum=False),
        "max_tss": _extreme_tss(rows),
    }
    metric_counts = {
        "tss": sum(get_tss(row["metrics"]) is not None for row in rows),
        "power": _metric_count(rows, "power", "avg_power_w"),
        "heart_rate": _metric_count(rows, "heart_rate", "avg_hr_bpm"),
        "cadence": _metric_count(rows, "cadence", "avg"),
        "speed": _metric_count(rows, "performance", "avg_speed_kmh"),
        "pace": _metric_count(rows, "performance", "avg_pace_s_per_km"),
    }
    return {
        "activity_count": len(rows),
        "active_days": len({row["start_time_local"][:10] for row in rows}),
        "median_session_duration_min": round(float(median(durations)), 2) if durations else None,
        "longest_inactivity_gap_days": _longest_inactivity_gap_days(rows),
        "sport_counts": dict(sorted(Counter(
            str(_section(row["metrics"], "identity").get("sport_type") or "unknown") for row in rows
        ).items())),
        "totals": totals,
        "weighted_averages": weighted,
        "best": best,
        "metric_counts": metric_counts,
    }


def _longest_inactivity_gap_days(rows: list[dict[str, Any]]) -> int | None:
    active_dates = sorted({datetime.fromisoformat(row["start_time_local"]).date() for row in rows})
    if len(active_dates) < 2:
        return None
    return max((later - earlier).days for earlier, later in zip(active_dates, active_dates[1:]))


def _missing_metric_names(rows: list[dict[str, Any]]) -> list[str]:
    checks = {
        "heart_rate": ("heart_rate", "avg_hr_bpm"),
        "cadence": ("cadence", "avg"),
        "speed": ("performance", "avg_speed_kmh"),
    }
    sports = {str(_section(row["metrics"], "identity").get("sport_type") or "").lower() for row in rows}
    if any(token in sport for sport in sports for token in ("cycl", "ride", "bike", "骑")):
        checks["power"] = ("power", "avg_power_w")
    if any(token in sport for sport in sports for token in ("run", "跑")):
        checks["pace"] = ("performance", "avg_pace_s_per_km")
    missing = []
    for label, (section, key) in checks.items():
        if not rows or all(_number(_section(row["metrics"], section).get(key)) is None for row in rows):
            missing.append(label)
    cycling = any(token in sport for sport in sports for token in ("cycl", "ride", "bike", "骑"))
    if cycling and (not rows or all(get_tss(row["metrics"]) is None for row in rows)):
        missing.append("tss")
    return missing


def _threshold_timeline(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Expose observed threshold changes without inventing effective dates."""
    timeline: list[dict[str, Any]] = []
    previous: tuple[float | None, str | None] | None = None
    for row in rows:
        power = _section(row["metrics"], "power")
        current = (_number(power.get("threshold_power_w")), str(power.get("threshold_power_source") or "") or None)
        if current == previous:
            continue
        if current[0] is not None:
            timeline.append({
                "observed_at": row["start_time_local"],
                "threshold_power_w": current[0],
                "source": current[1],
                "activity_key": row["activity_key"],
            })
        previous = current
    return timeline


def _compare_latest_periods(periods: list[dict[str, Any]]) -> dict[str, Any] | None:
    if len(periods) < 2:
        return None
    previous, current = periods[-2], periods[-1]
    paths = {
        "activity_count": (None, "activity_count"),
        "active_days": (None, "active_days"),
        "duration_min": ("totals", "duration_min"),
        "distance_km": ("totals", "distance_km"),
        "total_ascent_m": ("totals", "total_ascent_m"),
        "tss": ("totals", "tss"),
        "avg_power_w": ("weighted_averages", "avg_power_w"),
        "normalized_power_w": ("weighted_averages", "normalized_power_w"),
        "intensity_factor": ("weighted_averages", "intensity_factor"),
        "avg_hr_bpm": ("weighted_averages", "avg_hr_bpm"),
        "avg_speed_kmh": ("weighted_averages", "avg_speed_kmh"),
        "avg_pace_s_per_km": ("weighted_averages", "avg_pace_s_per_km"),
    }
    changes: dict[str, Any] = {}
    for label, (section, key) in paths.items():
        before = _number(previous.get(key) if section is None else _section(previous, section).get(key))
        after = _number(current.get(key) if section is None else _section(current, section).get(key))
        if before is None or after is None:
            continue
        changes[label] = {
            "previous": before,
            "current": after,
            "absolute_change": round(after - before, 3),
            "percent_change": round((after - before) / abs(before) * 100, 1) if before != 0 else None,
        }
    return {
        "previous_period": previous["period"],
        "current_period": current["period"],
        "changes": changes,
    }


def _period_identity(value: date, group_by: str) -> tuple[str, date, date]:
    if group_by == "day":
        return value.isoformat(), value, value
    if group_by == "month":
        start = value.replace(day=1)
        end = value.replace(day=calendar.monthrange(value.year, value.month)[1])
        return value.strftime("%Y-%m"), start, end
    start = value - timedelta(days=value.weekday())
    end = start + timedelta(days=6)
    iso_year, iso_week, _ = value.isocalendar()
    return f"{iso_year}-W{iso_week:02d}", start, end


def _metric_start(metrics: dict[str, Any], activity: dict[str, Any]) -> datetime | None:
    value = _section(metrics, "identity").get("start_time_local") or activity.get("start_time_local")
    text = str(value or "").strip().replace("Z", "+00:00")
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _deduplicate_activities(activities: Iterable[Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in activities:
        if not isinstance(value, dict):
            continue
        identity = str(value.get("activity_key") or value.get("fit_path") or "")
        if identity and identity in seen:
            continue
        if identity:
            seen.add(identity)
        output.append(value)
    return output


def _sum_metric(rows: list[dict[str, Any]], section: str, key: str) -> float | None:
    values = [_number(_section(row["metrics"], section).get(key)) for row in rows]
    present = [value for value in values if value is not None]
    return round(sum(present), 2) if present else None


def _sum_tss(rows: list[dict[str, Any]]) -> float | None:
    present = [value for row in rows if (value := get_tss(row["metrics"])) is not None]
    return round(sum(present), 2) if present else None


def _weighted_metric(
    rows: list[dict[str, Any]], section: str, key: str, *, weight: tuple[str, str], digits: int = 2,
) -> float | None:
    pairs: list[tuple[float, float]] = []
    for row in rows:
        value = _number(_section(row["metrics"], section).get(key))
        weight_value = _number(_section(row["metrics"], weight[0]).get(weight[1]))
        if value is not None and weight_value is not None and weight_value > 0:
            pairs.append((value, weight_value))
    if not pairs:
        return None
    return round(sum(value * item_weight for value, item_weight in pairs) / sum(item_weight for _, item_weight in pairs), digits)


def _extreme_metric(
    rows: list[dict[str, Any]], section: str, key: str, *, maximum: bool,
) -> dict[str, Any] | None:
    values = [
        (_number(_section(row["metrics"], section).get(key)), row)
        for row in rows
    ]
    present = [(value, row) for value, row in values if value is not None]
    if not present:
        return None
    value, row = (max if maximum else min)(present, key=lambda item: item[0])
    return {"value": value, "activity_key": row["activity_key"], "start_time_local": row["start_time_local"]}


def _extreme_tss(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    present = [
        (value, row)
        for row in rows
        if (value := get_tss(row["metrics"])) is not None
    ]
    if not present:
        return None
    value, row = max(present, key=lambda item: item[0])
    return {"value": value, "activity_key": row["activity_key"], "start_time_local": row["start_time_local"]}


def _metric_count(rows: list[dict[str, Any]], section: str, key: str) -> int:
    return sum(_number(_section(row["metrics"], section).get(key)) is not None for row in rows)


def _section(value: dict[str, Any], key: str) -> dict[str, Any]:
    nested = value.get(key)
    return nested if isinstance(nested, dict) else {}


def _first_number(*values: Any) -> float | None:
    for value in values:
        converted = _number(value)
        if converted is not None:
            return converted
    return None


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
