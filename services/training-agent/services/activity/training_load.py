"""训练负荷汇总工具.

这个模块只做确定性聚合:读取已选活动的结构化指标，提取 TSS/IF 等负荷线索,
只输出结构化训练负荷。是否疲劳、怎么安排路线,交给后续 LLM 步骤判断。
"""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime
from typing import Any

from services.activity.reporting import read_activity_report
from services.activity.history import load_activity_metrics
from domain.analysis.artifacts import get_analysis_summary, get_tss


def summarize_training_load(
    activities: list[dict[str, Any]],
    *,
    scope: dict[str, Any] | None = None,
    name: str = "summarize_recent_training_load",
) -> dict[str, Any]:
    """Summarize explicit activities without conversation dependencies."""
    activities = [activity for activity in activities if isinstance(activity, dict)]
    if not activities:
        return {
            "error": "missing_selected_activities",
            "message": "summarize_recent_training_load requires selected activities.",
        }

    reports: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for activity in activities:
        summary, summary_error = read_activity_report(activity)
        metrics, metrics_source, metrics_error = load_activity_metrics(activity)
        if metrics is None:
            missing.append({
                "activity_key": activity.get("activity_key"),
                "error": metrics_error or summary_error,
            })
            continue
        reports.append(_training_load_activity(
            activity,
            summary or {},
            activity_metrics=metrics,
            metrics_source=metrics_source,
        ))

    if not reports:
        return {
            "error": "missing_activity_metrics",
            "message": "Need at least one activity with readable structured metrics to summarize training load.",
            "missing": missing,
        }

    summary = _build_training_load_summary(reports, missing=missing, scope=scope or {})
    return {
        "step": name,
        "status": "completed",
        "result": summary,
    }


def _training_load_activity(
    activity: dict[str, Any],
    summary: dict[str, Any],
    *,
    activity_metrics: dict[str, Any],
    metrics_source: str,
) -> dict[str, Any]:
    fit_summary = summary.get("fit_summary") if isinstance(summary.get("fit_summary"), dict) else {}
    analysis_summary = get_analysis_summary(summary)
    identity = activity_metrics.get("identity") if isinstance(activity_metrics.get("identity"), dict) else {}
    scale = activity_metrics.get("scale") if isinstance(activity_metrics.get("scale"), dict) else {}
    power = activity_metrics.get("power") if isinstance(activity_metrics.get("power"), dict) else {}
    tss = get_tss(activity_metrics)
    intensity_factor = _number(power.get("intensity_factor"))
    return {
        "activity_key": summary.get("activity_key") or activity.get("activity_key"),
        "activity_index": activity.get("activity_index"),
        "summary_label": analysis_summary.get("summary_label") or activity.get("summary_label"),
        "start_time_local": (
            identity.get("start_time_local")
            or fit_summary.get("start_time_local")
            or activity.get("start_time_local")
        ),
        "sport_type": identity.get("sport_type") or fit_summary.get("sport_type") or activity.get("sport_type"),
        "duration_min": _number(scale.get("duration_min"), activity.get("duration_min")),
        "distance_km": _number(scale.get("distance_km"), activity.get("distance_km")),
        "load_label": analysis_summary.get("load_label") or activity.get("load_label"),
        "main_stimulus": analysis_summary.get("main_stimulus"),
        "brief": analysis_summary.get("brief"),
        "tss": tss,
        "intensity_factor": intensity_factor,
        "metrics_source": metrics_source,
        "load_class": _classify_activity_load(tss, intensity_factor),
    }


def _build_training_load_summary(
    reports: list[dict[str, Any]],
    *,
    missing: list[dict[str, Any]],
    scope: dict[str, Any],
) -> dict[str, Any]:
    sorted_reports = sorted(reports, key=lambda item: str(item.get("start_time_local") or ""))
    tss_values = [float(item["tss"]) for item in sorted_reports if item.get("tss") is not None]
    if_values = [float(item["intensity_factor"]) for item in sorted_reports if item.get("intensity_factor") is not None]
    total_distance = round(sum(float(item.get("distance_km") or 0) for item in sorted_reports), 2)
    total_duration = round(sum(float(item.get("duration_min") or 0) for item in sorted_reports), 1)
    hard_count = sum(1 for item in sorted_reports if item.get("load_class") in {"hard", "very_hard"})
    easy_count = sum(1 for item in sorted_reports if item.get("load_class") in {"recovery", "easy"})
    total_tss = round(sum(tss_values), 1) if tss_values else None
    avg_if = round(sum(if_values) / len(if_values), 3) if if_values else None
    recency = _recency(sorted_reports)
    return {
        "kind": "training_load_summary",
        "scope": scope,
        "activity_count": len(sorted_reports),
        "missing_summary_count": len(missing),
        "totals": {
            "distance_km": total_distance,
            "duration_min": total_duration,
            "tss": total_tss,
        },
        "intensity": {
            "basis": _intensity_basis(tss_values, if_values),
            "source_counts": dict(sorted(Counter(
                str(item.get("metrics_source") or "unknown") for item in sorted_reports
            ).items())),
            "hard_activity_count": hard_count,
            "easy_activity_count": easy_count,
            "total_tss": total_tss,
            "avg_if": avg_if,
            "max_if": round(max(if_values), 3) if if_values else None,
        },
        "recency": recency,
        "activities": sorted_reports,
        "missing": missing,
    }


def _classify_activity_load(tss: float | None, intensity_factor: float | None) -> str:
    if intensity_factor is not None:
        if intensity_factor >= 0.95:
            return "very_hard"
        if intensity_factor >= 0.85:
            return "hard"
        if intensity_factor >= 0.75:
            return "moderate"
        if intensity_factor >= 0.60:
            return "easy"
        return "recovery"
    if tss is not None:
        if tss >= 150:
            return "very_hard"
        if tss >= 100:
            return "hard"
        if tss >= 50:
            return "moderate"
        return "easy"
    return "unknown"


def _recency(reports: list[dict[str, Any]]) -> dict[str, Any]:
    dates = [_date_part(report.get("start_time_local")) for report in reports]
    dates = [item for item in dates if item is not None]
    if not dates:
        return {"last_activity_date": None, "days_since_last_activity": None}
    last_date = max(dates)
    return {
        "last_activity_date": last_date.isoformat(),
        "days_since_last_activity": (date.today() - last_date).days,
    }


def _intensity_basis(tss_values: list[float], if_values: list[float]) -> str:
    if tss_values and if_values:
        return "power_tss_if"
    if tss_values:
        return "power_tss"
    if if_values:
        return "power_if"
    return "unavailable"


def _date_part(value: Any) -> date | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text[:10]).date()
    except ValueError:
        return None


def _number(*values: Any) -> float | None:
    for value in values:
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None
