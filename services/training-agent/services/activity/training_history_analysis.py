"""Conservative longitudinal analysis over deterministic activity facts.

This service produces the stable document described by the professional
training-history Skill.  It does not ask an LLM to calculate values and it
does not promote heterogeneous aggregate changes into fitness/fatigue claims.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Iterable

from services.activity.history import calculate_history_metrics


def analyze_training_history(
    activities: Iterable[dict[str, Any]],
    *,
    scope: dict[str, Any] | None = None,
    group_by: str = "week",
    sport_type: str | None = None,
    combine_sports_for_volume: bool = False,
    name: str = "analyze_training_history",
    today: date | None = None,
) -> dict[str, Any]:
    """Build a UI-ready history assessment with explicit evidence limits."""
    selected = [item for item in activities if isinstance(item, dict)]
    normalized_sport = _normalize_sport(sport_type)
    if normalized_sport:
        selected = [item for item in selected if _normalize_sport(item.get("sport_type")) == normalized_sport]

    sports = sorted({
        value for item in selected
        if (value := _normalize_sport(item.get("sport_type")))
    })
    if len(sports) > 1 and not combine_sports_for_volume:
        return {
            "error": "mixed_sports_require_filter",
            "message": "历史表现分析必须按运动类型拆分；请指定 cycling、running 或 walking。",
            "sport_types": sports,
        }

    metrics_result = calculate_history_metrics(
        selected,
        scope=scope,
        group_by=group_by,
        name="calculate_history_metrics",
    )
    if metrics_result.get("error"):
        return metrics_result
    metrics = metrics_result["result"]
    document = _analysis_document(
        metrics,
        sport_type=normalized_sport or (sports[0] if len(sports) == 1 else "combined_volume"),
        combine_sports_for_volume=combine_sports_for_volume,
        today=today or date.today(),
    )
    return {
        "step": name,
        "status": "completed",
        "result": document,
    }


def _analysis_document(
    metrics: dict[str, Any], *, sport_type: str, combine_sports_for_volume: bool,
    today: date,
) -> dict[str, Any]:
    periods = metrics.get("periods") if isinstance(metrics.get("periods"), list) else []
    comparison = metrics.get("comparison") if isinstance(metrics.get("comparison"), dict) else None
    previous = periods[-2] if len(periods) >= 2 else None
    current = periods[-1] if periods else None
    coverage_raw = metrics.get("coverage") if isinstance(metrics.get("coverage"), dict) else {}
    consistency = metrics.get("consistency") if isinstance(metrics.get("consistency"), dict) else {}

    coverage = {
        "activity_count": coverage_raw.get("included_activity_count", 0),
        "comparable_session_count": 0,
        "missing_activity_count": coverage_raw.get("missing_activity_count", 0),
        "duplicate_activity_count": coverage_raw.get("duplicate_activity_count", 0),
        "missing_metrics": coverage_raw.get("missing_metrics") or [],
        "threshold_or_method_changes": _threshold_or_method_changes(consistency),
        "source_counts": coverage_raw.get("source_counts") or {},
    }
    dimensions = [
        _dimension("volume", comparison, ("duration_min", "distance_km")),
        _dimension("intensity", comparison, ("tss", "intensity_factor"),
                   available=bool(consistency.get("comparable_power_load", False))),
        _dimension("consistency", comparison, ("activity_count", "active_days")),
        _unavailable_dimension("performance", "缺少匹配路线或标准化训练标识，不能从异质活动聚合值判断表现变化。"),
        _unavailable_dimension("efficiency", "缺少重复稳态片段及外部输出/心率配对证据。"),
        _unavailable_dimension("recovery", "活动文件缺少主观恢复信息，且没有重复可比训练的收敛证据。"),
    ]
    if combine_sports_for_volume:
        for dimension in dimensions:
            if dimension["name"] not in {"volume", "consistency"}:
                dimension.update(_unavailable_dimension(
                    dimension["name"], "合并运动类型只支持训练量与规律性，不比较功率、配速或负荷方法。",
                ))

    conclusion = _conclusion(dimensions, previous=previous, current=current)
    warnings = []
    if not consistency.get("comparable_power_load", False):
        warnings.append("功率阈值或 TSS 计算来源发生变化，强度/负荷趋势不可直接比较。")
    if coverage["comparable_session_count"] == 0:
        warnings.append("尚无匹配路线或标准化课表证据；不能据此宣称体能提升或下降。")
    if coverage["missing_metrics"]:
        warnings.append("部分分析维度缺少传感器数据：" + "、".join(coverage["missing_metrics"]))
    current_scope = _period_scope(current, today=today)
    if current_scope and current_scope["status"] == "closed":
        warnings.append(
            f"最新有数据的周期 {current_scope['label']} 已于 {current_scope['end']} 结束；"
            "不得将它描述为‘当前周期仍在进行’。"
        )

    return {
        "kind": "training_history_analysis",
        "scope": {
            "sport_type": sport_type,
            "group_by": metrics.get("group_by"),
            # ``current_period`` means the latest observed data bucket, not
            # necessarily the calendar period containing today's date.
            "current_period": current_scope,
            "baseline_period": _period_scope(previous, today=today),
            "requested_scope": metrics.get("scope") or {},
        },
        "coverage": coverage,
        "conclusion": conclusion,
        "dimensions": dimensions,
        "warnings": warnings,
        "missing_data": [
            "matched_session_identifiers",
            "steady_state_efficiency_windows",
            "subjective_recovery",
            "weather_and_wind",
        ],
        "recommended_next_check": "选择一条重复路线或标准化训练，累计至少 3 次可比记录后再判断表现与效率趋势。",
        "series": {
            "group_by": metrics.get("group_by"),
            "periods": periods,
        },
        "view": {
            "type": "training_history",
            "table_columns": ["dimension", "baseline", "current", "change", "confidence"],
            "chart_metrics": ["duration_min", "distance_km", "tss"],
        },
    }


def _dimension(
    name: str,
    comparison: dict[str, Any] | None,
    metric_names: tuple[str, ...],
    *,
    available: bool = True,
) -> dict[str, Any]:
    if not comparison or not available:
        reason = "缺少两个非重叠周期。" if not comparison else "阈值或负荷计算方法不一致。"
        return _unavailable_dimension(name, reason)
    changes = comparison.get("changes") if isinstance(comparison.get("changes"), dict) else {}
    evidence = []
    for metric in metric_names:
        change = changes.get(metric)
        if not isinstance(change, dict):
            continue
        evidence.append({
            "metric": metric,
            "baseline": change.get("previous"),
            "current": change.get("current"),
            "absolute_change": change.get("absolute_change"),
            "percent_change": change.get("percent_change"),
            "unit": _metric_unit(metric),
            "activity_keys": [],
        })
    if not evidence:
        return _unavailable_dimension(name, "当前结构化事实没有这个维度的可比指标。")
    directions = [_direction(item.get("percent_change")) for item in evidence]
    direction = directions[0] if len(set(directions)) == 1 else "mixed"
    return {
        "name": name,
        "assessment": _dimension_assessment(name, direction),
        "direction": direction,
        "confidence": "medium" if direction != "mixed" else "low",
        "evidence": evidence,
        "confounders": [],
    }


def _unavailable_dimension(name: str, reason: str) -> dict[str, Any]:
    return {
        "name": name,
        "assessment": "数据不足，暂时无法判断",
        "direction": "unavailable",
        "confidence": "low",
        "evidence": [],
        "confounders": [reason],
    }


def _conclusion(
    dimensions: list[dict[str, Any]], *, previous: dict[str, Any] | None, current: dict[str, Any] | None,
) -> dict[str, Any]:
    if previous is None or current is None:
        return {
            "assessment": "insufficient_data",
            "confidence": "low",
            "summary": "不足两个非重叠周期，暂时无法判断训练趋势。",
        }
    observed = [item for item in dimensions if item.get("direction") not in {"unavailable"}]
    stable = observed and all(item.get("direction") == "stable" for item in observed)
    assessment = "stable" if stable else "mixed"
    return {
        "assessment": assessment,
        "confidence": "low",
        "summary": (
            "训练量、强度和规律性可做描述性比较，但缺少匹配训练与效率证据，"
            "不能据此宣称体能提升、下降或累积疲劳。"
        ),
    }


def _threshold_or_method_changes(consistency: dict[str, Any]) -> list[dict[str, Any]]:
    changes = list(consistency.get("threshold_timeline") or [])
    sources = list(consistency.get("tss_sources") or [])
    if len(sources) > 1:
        changes.append({"type": "tss_source_change", "sources": sources})
    return changes


def _period_scope(period: dict[str, Any] | None, *, today: date) -> dict[str, Any] | None:
    if not period:
        return None
    end = date.fromisoformat(str(period.get("period_end")))
    return {
        "label": period.get("period"),
        "start": period.get("period_start"),
        "end": period.get("period_end"),
        "status": "open" if today <= end else "closed",
        "as_of": today.isoformat(),
        "activity_count": period.get("activity_count", 0),
        "active_days": period.get("active_days", 0),
    }


def _direction(percent_change: Any) -> str:
    try:
        value = float(percent_change)
    except (TypeError, ValueError):
        return "unavailable"
    if value >= 5:
        return "up"
    if value <= -5:
        return "down"
    return "stable"


def _dimension_assessment(name: str, direction: str) -> str:
    labels = {"up": "增加", "down": "下降", "stable": "基本稳定", "mixed": "变化方向不一致"}
    return f"{name} {labels.get(direction, '暂时无法判断')}"


def _metric_unit(metric: str) -> str:
    return {
        "duration_min": "min",
        "distance_km": "km",
        "tss": "TSS",
        "intensity_factor": "IF",
        "activity_count": "count",
        "active_days": "day",
    }.get(metric, "")


def _normalize_sport(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if any(token in text for token in ("ride", "cycling", "bike", "骑")):
        return "cycling"
    if any(token in text for token in ("run", "running", "跑")):
        return "running"
    if any(token in text for token in ("walk", "walking", "hike", "徒步", "步行")):
        return "walking"
    return text or None
