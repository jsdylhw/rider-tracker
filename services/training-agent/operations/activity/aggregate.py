"""读取 SQLite V2 报告的多活动确定性汇总。"""

from __future__ import annotations

from typing import Any, Iterable

from services.activity.reporting import read_activity_report
from domain.analysis.artifacts import get_analysis_summary


def aggregate_summaries(activities: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """汇总活动 summary，不重新解析 FIT，也不调用 LLM。"""
    included: list[dict[str, Any]] = []
    omitted: list[dict[str, Any]] = []
    for activity in activities:
        if not isinstance(activity, dict):
            continue
        summary, _ = read_activity_report(activity)
        if summary is None:
            omitted.append({
                "activity_key": activity.get("activity_key"),
                "reason": "report_unavailable",
            })
            continue
        fit_summary = summary.get("fit_summary") if isinstance(summary.get("fit_summary"), dict) else {}
        analysis = get_analysis_summary(summary)
        included.append({
            "activity_key": activity.get("activity_key") or summary.get("activity_key"),
            "sport_type": fit_summary.get("sport_type") or activity.get("sport_type"),
            "distance_km": _distance_km(fit_summary, activity),
            "duration_min": _duration_min(fit_summary, activity),
            "summary_label": analysis.get("summary_label"),
            "main_stimulus": analysis.get("main_stimulus"),
            "load_label": analysis.get("load_label"),
        })
    return {
        "schema_version": "activity_operation_aggregate.v1",
        "operation": "aggregate_summaries",
        "status": "partial" if omitted else "completed",
        "included_count": len(included),
        "omitted_count": len(omitted),
        "activities": included,
        "omitted": omitted,
        "totals": {
            "distance_km": round(sum(float(item.get("distance_km") or 0) for item in included), 2),
            "duration_min": round(sum(float(item.get("duration_min") or 0) for item in included), 1),
        },
    }


def _distance_km(fit_summary: dict[str, Any], activity: dict[str, Any]) -> float:
    distance_m = fit_summary.get("distance_m")
    if isinstance(distance_m, (int, float)):
        return round(float(distance_m) / 1000, 3)
    return float(activity.get("distance_km") or 0)


def _duration_min(fit_summary: dict[str, Any], activity: dict[str, Any]) -> float:
    duration_s = fit_summary.get("duration_s")
    if isinstance(duration_s, (int, float)):
        return round(float(duration_s) / 60, 2)
    return float(activity.get("duration_min") or 0)
