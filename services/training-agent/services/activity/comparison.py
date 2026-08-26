"""Deterministic multi-activity comparison over imported facts."""

from __future__ import annotations

from typing import Any

from domain.analysis.artifacts import get_analysis_summary, get_tss
from services.activity.history import load_activity_metrics
from services.activity.reporting import read_activity_report


def compare_activities(
    activities: list[dict[str, Any]],
    *,
    name: str = "compare_activities",
) -> dict[str, Any]:
    """Compare explicit activities without depending on conversation state."""
    activities = [activity for activity in activities if isinstance(activity, dict)]
    if len(activities) < 2:
        return {
            "error": "not_enough_activities",
            "message": "compare_activities requires at least two selected activities.",
        }

    loaded: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for activity in activities:
        metrics, source, error = load_activity_metrics(activity)
        if metrics is None:
            missing.append({**_compact_missing_summary(activity), "error": error})
            continue
        # Qualitative labels enrich presentation when a report exists, but the
        # comparison remains valid for an imported activity without one.
        summary, _ = read_activity_report(activity)
        loaded.append(_activity_from_facts(activity, metrics, summary or {}, source=source))
    if len(loaded) < 2:
        return {
            "error": "not_enough_activity_facts",
            "message": "Need at least two activities with readable structured facts to compare.",
            "missing": missing,
        }

    loaded = sorted(loaded, key=lambda item: str(item.get("start_time_local") or ""))
    comparison = _build_comparison(loaded)
    comparison["missing"] = missing
    return {
        "step": name,
        "status": "completed",
        "result": comparison,
        "answer": _format_comparison_answer(comparison),
    }


def _activity_from_facts(
    activity: dict[str, Any],
    metrics: dict[str, Any],
    summary: dict[str, Any],
    *,
    source: str,
) -> dict[str, Any]:
    fit_summary = summary.get("fit_summary") if isinstance(summary.get("fit_summary"), dict) else {}
    analysis_summary = get_analysis_summary(summary)
    scale = metrics.get("scale") if isinstance(metrics.get("scale"), dict) else {}
    power = metrics.get("power") if isinstance(metrics.get("power"), dict) else {}
    identity = metrics.get("identity") if isinstance(metrics.get("identity"), dict) else {}
    return {
        "activity_key": metrics.get("activity_key") or activity.get("activity_key"),
        "file_name": activity.get("file_name") or _path_name(str(activity.get("fit_path") or "")),
        "start_time_local": identity.get("start_time_local") or fit_summary.get("start_time_local") or activity.get("start_time_local"),
        "sport_type": identity.get("sport_type") or fit_summary.get("sport_type") or activity.get("sport_type"),
        "duration_min": _first_number(
            scale.get("duration_min"),
            _seconds_to_minutes(fit_summary.get("duration_s")),
            activity.get("duration_min"),
        ),
        "distance_km": _first_number(
            scale.get("distance_km"),
            _meters_to_km(fit_summary.get("distance_m")),
            activity.get("distance_km"),
        ),
        "summary_label": analysis_summary.get("summary_label"),
        "main_stimulus": analysis_summary.get("main_stimulus"),
        "load_label": analysis_summary.get("load_label"),
        "brief": analysis_summary.get("brief"),
        "quality_notes": analysis_summary.get("quality_notes") if isinstance(analysis_summary.get("quality_notes"), list) else [],
        "tss": get_tss(metrics),
        "intensity_factor": _number(power.get("intensity_factor")),
        "metrics_source": source,
    }


def _build_comparison(reports: list[dict[str, Any]]) -> dict[str, Any]:
    distances = [report.get("distance_km") for report in reports if report.get("distance_km") is not None]
    durations = [report.get("duration_min") for report in reports if report.get("duration_min") is not None]
    longest = max(reports, key=lambda item: float(item.get("distance_km") or 0))
    longest_duration = max(reports, key=lambda item: float(item.get("duration_min") or 0))
    higher_load = _higher_load_report(reports)
    return {
        "kind": "activity_comparison",
        "count": len(reports),
        "activities": reports,
        "totals": {
            "distance_km": round(sum(float(value or 0) for value in distances), 2),
            "duration_min": round(sum(float(value or 0) for value in durations), 1),
        },
        "highlights": {
            "longest_distance_activity_key": longest.get("activity_key"),
            "longest_duration_activity_key": longest_duration.get("activity_key"),
            "higher_training_value_activity_key": higher_load.get("activity_key") if higher_load else None,
        },
        "training_judgement": _training_judgement(reports, higher_load),
    }


def _higher_load_report(reports: list[dict[str, Any]]) -> dict[str, Any] | None:
    def score(report: dict[str, Any]) -> tuple[float, float, float, float]:
        load_text = str(report.get("load_label") or "")
        label_score = 0.0
        if "非常轻" in load_text or "极低" in load_text:
            label_score = 1.0
        if "低" in load_text:
            label_score = max(label_score, 1.0)
        if "中" in load_text:
            label_score = max(label_score, 2.0)
        if "高" in load_text:
            label_score = max(label_score, 3.0)
        return (
            float(report.get("tss") or -1),
            float(report.get("intensity_factor") or -1),
            label_score,
            float(report.get("duration_min") or 0),
        )

    return max(reports, key=score) if reports else None


def _training_judgement(
    reports: list[dict[str, Any]],
    higher_load: dict[str, Any] | None,
) -> str:
    if not higher_load:
        return "导入时结构化事实不足以判断相对训练负荷。"
    label = higher_load.get("summary_label") or higher_load.get("activity_key")
    tss = higher_load.get("tss")
    load = higher_load.get("load_label") or "未知负荷"
    basis = f"结构化 TSS 为 {tss}" if tss is not None else f"分析标签为 {load}"
    return f"相对负荷更高的是 {label}，判断依据是{basis}。"


def _format_comparison_answer(comparison: dict[str, Any]) -> str:
    activities = comparison.get("activities") or []
    lines = [
        f"已基于 {len(activities)} 条导入时结构化事实完成对比,没有重新解析 FIT 或依赖报告文本。",
        f"总量: {comparison['totals']['distance_km']} km, {comparison['totals']['duration_min']} 分钟。",
    ]
    for index, activity in enumerate(activities, start=1):
        lines.append(
            f"{index}. {activity.get('start_time_local') or activity.get('activity_key')}: "
            f"{activity.get('summary_label') or '未命名活动'}, "
            f"{activity.get('distance_km')} km / {activity.get('duration_min')} 分钟, "
            f"刺激: {activity.get('main_stimulus') or '未知'}, "
            f"负荷标签: {activity.get('load_label') or '未知'}"
            f"，TSS: {activity.get('tss') if activity.get('tss') is not None else '无数据'}。"
        )
    lines.append(comparison.get("training_judgement") or "")
    return "\n".join(line for line in lines if line)


def _compact_missing_summary(activity: dict[str, Any]) -> dict[str, Any]:
    return {
        "activity_key": activity.get("activity_key"),
        "fit_path": activity.get("fit_path"),
    }


def _path_name(value: str) -> str:
    return value.replace("\\", "/").rstrip("/").split("/")[-1]


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _first_number(*values: Any) -> float | None:
    for value in values:
        converted = _number(value)
        if converted is not None:
            return converted
    return None


def _seconds_to_minutes(value: Any) -> float | None:
    seconds = _number(value)
    return round(seconds / 60, 2) if seconds is not None else None


def _meters_to_km(value: Any) -> float | None:
    meters = _number(value)
    return round(meters / 1000, 3) if meters is not None else None
