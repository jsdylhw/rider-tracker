"""Context-free activity inspection, segment discovery, and analysis services."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from domain.analysis.models import AnalysisRequest, ResolvedTarget, SegmentRef
from services.activity.history import load_activity_metrics
from fit.analysis.data import (
    get_activity_overview_tool,
    get_time_intervals_tool,
)
from fit.analysis.segments import scan_activity_segments
from fit.analysis.sprints import detect_sprints
from domain.analysis.artifacts import get_tss
from storage.repositories.activity import ActivityStore
from fit.parser import parse_fit


SEGMENT_TYPES = {"sprint", "interval", "effort", "climb", "fast_running_segment"}
FocusedAnalyzer = Callable[[dict[str, Any], str], dict[str, Any]]


def discover_activity_segments(activity_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Resolve semantic segment arguments against one persisted activity."""
    segment_type = str(arguments.get("segment_type") or "effort")
    if segment_type not in SEGMENT_TYPES:
        return {"error": "unsupported_segment_type", "message": f"unsupported segment_type: {segment_type}"}
    ordinal = arguments.get("ordinal")
    if ordinal is not None and (not isinstance(ordinal, int) or ordinal < 1):
        return {"error": "invalid_ordinal", "message": "ordinal must be a positive integer"}
    activity = ActivityStore().get_activity(activity_id)
    if activity is None:
        return {"error": "activity_not_found", "message": f"activity not found: {activity_id}"}
    facts = ActivityStore().get_facts(activity_id)
    features = facts.get("features") if isinstance(facts, dict) else None
    if isinstance(features, dict) and features.get("schema_version") == "activity_features.v1":
        scan = _scan_from_stored_features(features, segment_type=segment_type)
    else:
        fit_path = _fit_path(activity)
        if fit_path is None:
            return {"error": "missing_fit_file", "message": "The selected activity FIT file is unavailable."}
        try:
            parsed = parse_fit(fit_path)
            # This fallback is only for legacy activities that have not yet had
            # their import-time facts rebuilt.
            requested_window = arguments.get("window_seconds")
            window_seconds = int(requested_window or (10 if segment_type == "sprint" else 30))
            step_seconds = int(arguments.get("step_seconds") or (5 if window_seconds <= 15 else 10))
            if segment_type == "sprint":
                sprint_scan = detect_sprints(parsed, max_segments=int(arguments.get("max_segments") or 12))
                scan = {
                    **sprint_scan,
                    "efforts": sprint_scan.get("segments") or [],
                    "summary": {"effort_count": int(sprint_scan.get("count") or 0)},
                }
            else:
                scan = scan_activity_segments(
                    parsed,
                    window_seconds=window_seconds,
                    step_seconds=step_seconds,
                    max_segments=int(arguments.get("max_segments") or 12),
                )
        except Exception as exc:
            return {"error": "segment_scan_failed", "message": f"{type(exc).__name__}: {exc}"}

    candidates = _segment_candidates(scan, activity_id=activity_id, requested_type=segment_type)
    if ordinal is not None and ordinal > len(candidates):
        return {
            "error": "segment_ordinal_out_of_range",
            "message": f"Only {len(candidates)} matching segments were detected.",
            "segments": candidates,
        }
    return {
        "schema_version": "segment_selection.v1",
        "activity_id": activity_id,
        "segment_type": segment_type,
        "count": len(candidates),
        "selected_ordinal": ordinal,
        "segments": candidates,
        "scan_summary": scan.get("summary") if isinstance(scan, dict) else {},
    }


def analyze_resolved_target(
    request: AnalysisRequest,
    *,
    activity_ids: list[str],
    segments_raw: list[dict[str, Any]],
    focused_analyzer: FocusedAnalyzer | None = None,
) -> dict[str, Any]:
    """Analyze an already-resolved target without reading conversation state."""
    if not activity_ids:
        return {"error": "missing_analysis_focus", "message": "Select one or more activities before analysis."}
    activities = [ActivityStore().get_activity(value) for value in activity_ids]
    activities = [value for value in activities if isinstance(value, dict)]
    segments = tuple(_segment_ref(value) for value in segments_raw)
    target = ResolvedTarget(
        activity_ids=tuple(activity_ids),
        segments=segments,
        objective=request.objective,
        depth=request.depth,
        question=request.question,
        metric_scope=request.metric_scope,
    )

    if request.depth == "full":
        return {
            "error": "full_report_requires_explicit_tool",
            "message": "Use generate_full_report for a canonical full activity report.",
        }
    if segments:
        if request.objective == "compare_segments":
            result = _compare_segments([value.to_dict() | value.metrics for value in segments])
        elif len(activities) == 1:
            result = _inspect_segments_with_atomic_tools(
                activities[0], [value.to_dict() | value.metrics for value in segments],
            )
        else:
            result = {"status": "unavailable", "error": "segments_span_multiple_activities"}
    elif request.objective == "compare_activities":
        result = _compare_activities_with_atomic_tools(activities)
    elif len(activities) == 1:
        # Standard high-level objectives begin with deterministic facts.  A
        # free-form/deep objective is answered by the focused child agent below.
        if request.objective == "inspect_activity" and request.depth == "inspect":
            result = _inspect_activity_with_atomic_tools(activities[0])
        else:
            result = _focused_activity_analysis(activities[0], request, focused_analyzer)
    else:
        result = _inspect_collection_with_atomic_tools(activities)

    return {
        "status": str(result.get("status") or "completed"),
        "request": request.to_dict(),
        "target": target.to_dict(),
        "analysis": result,
    }


def _focused_activity_analysis(
    activity: dict[str, Any],
    request: AnalysisRequest,
    focused_analyzer: FocusedAnalyzer | None,
) -> dict[str, Any]:
    if focused_analyzer is None:
        return {"status": "unavailable", "error": "focused_analyzer_unavailable"}
    question = request.question or _objective_question(request.objective)
    response = focused_analyzer(activity, question)
    if response.get("error"):
        return {"status": "unavailable", **response}
    return {
        "status": "completed",
        "answer": response.get("answer"),
        "analysis_summary": (response.get("result") or {}).get("analysis_summary") or {},
        "source": "analysis_agent",
    }


def _inspect_activity_with_atomic_tools(activity: dict[str, Any]) -> dict[str, Any]:
    activity_id = str(activity.get("activity_key") or "")
    facts = ActivityStore().get_facts(activity_id) if activity_id else None
    if isinstance(facts, dict):
        # Import-time facts are the default L1 inspection source.  They contain
        # the same deterministic metrics/features sent to the child agent.
        return {
            "status": "completed",
            "source": "activity_facts",
            "activity_id": activity_id,
            "metrics": facts.get("metrics") or {},
            "features": facts.get("features") or {},
        }
    parsed = _parse_activity(activity)
    if parsed is None:
        return {"status": "unavailable", "error": "missing_fit_file"}
    return {
        "status": "completed",
        "source": "legacy_fit_overview",
        "activity_id": activity.get("activity_key"),
        "overview": get_activity_overview_tool(parsed),
    }


def _inspect_collection_with_atomic_tools(activities: list[dict[str, Any]]) -> dict[str, Any]:
    """Reuse the structured-metrics atomic loader without generating reports."""
    rows: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for activity in activities:
        metrics, source, error = load_activity_metrics(activity)
        if metrics is None:
            missing.append({"activity_id": activity.get("activity_key"), "error": error})
            continue
        identity = _section(metrics, "identity")
        scale = _section(metrics, "scale")
        power = _section(metrics, "power")
        heart_rate = _section(metrics, "heart_rate")
        rows.append({
            "activity_id": metrics.get("activity_key") or activity.get("activity_key"),
            "start_time_local": identity.get("start_time_local") or activity.get("start_time_local"),
            "sport_type": identity.get("sport_type") or activity.get("sport_type"),
            "duration_min": _number(scale.get("duration_min") or activity.get("duration_min")),
            "distance_km": _number(scale.get("distance_km") or activity.get("distance_km")),
            "normalized_power_w": _number(power.get("normalized_power_w")),
            "intensity_factor": _number(power.get("intensity_factor")),
            "average_hr_bpm": _number(heart_rate.get("avg_hr_bpm")),
            "tss": _number(get_tss(metrics)),
            "source": source,
        })
    return {
        "schema_version": "activity_collection_inspection.v1",
        "status": "completed" if rows else "unavailable",
        "selected_count": len(activities),
        "included_count": len(rows),
        "totals": {
            "duration_min": _sum(rows, "duration_min", digits=1),
            "distance_km": _sum(rows, "distance_km", digits=2),
            "tss": _sum(rows, "tss", digits=1),
        },
        "activities": rows,
        "missing": missing,
    }


def _inspect_segments_with_atomic_tools(
    activity: dict[str, Any], segments: list[dict[str, Any]],
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "completed",
        "activity_id": activity.get("activity_key"),
        "segment_count": len(segments),
        "segments": segments,
    }
    if len(segments) != 1:
        return result
    parsed = _parse_activity(activity)
    if parsed is None:
        result["data_quality"] = ["missing_fit_file"]
        return result
    segment = segments[0]
    duration = max(1.0, float(segment.get("end_seconds") or 0) - float(segment.get("start_seconds") or 0))
    # Reuse the existing interval atom only after the semantic locator has
    # frozen a concrete window.
    result["intervals"] = get_time_intervals_tool(
        parsed,
        bucket_seconds=max(1, min(30, int(round(duration / 4)))),
        start_s=segment.get("start_seconds"),
        end_s=segment.get("end_seconds"),
    )
    return result


def _compare_segments(segments: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": "analysis_comparison.v1",
        "status": "completed" if len(segments) >= 2 else "unavailable",
        "comparison_type": "segments",
        "segments": segments,
        "highlights": {
            "highest_average_power_segment_id": _max_id(segments, "avg_power_w", "segment_id"),
            "highest_peak_power_segment_id": _max_id(segments, "max_power_w", "segment_id"),
        },
    }


def _compare_activities_with_atomic_tools(activities: list[dict[str, Any]]) -> dict[str, Any]:
    inspection = _inspect_collection_with_atomic_tools(activities)
    rows = inspection.get("activities") or []
    return {
        "schema_version": "analysis_comparison.v1",
        "status": "completed" if len(rows) >= 2 else "unavailable",
        "comparison_type": "activities",
        "activities": rows,
        "highlights": {
            "highest_tss_activity_id": _max_id(rows, "tss", "activity_id"),
            "highest_if_activity_id": _max_id(rows, "intensity_factor", "activity_id"),
            "longest_activity_id": _max_id(rows, "duration_min", "activity_id"),
        },
        "missing": inspection.get("missing") or [],
    }


def _parse_activity(activity: dict[str, Any]) -> dict[str, Any] | None:
    path = _fit_path(activity)
    if path is None:
        return None
    try:
        return parse_fit(path)
    except Exception:
        return None


def _section(value: dict[str, Any], key: str) -> dict[str, Any]:
    section = value.get(key)
    return section if isinstance(section, dict) else {}


def _sum(rows: list[dict[str, Any]], key: str, *, digits: int) -> float | None:
    values = [_number(row.get(key)) for row in rows]
    present = [value for value in values if value is not None]
    return round(sum(present), digits) if present else None


def _max_id(rows: list[dict[str, Any]], metric: str, id_key: str) -> str | None:
    candidates = [row for row in rows if _number(row.get(metric)) is not None]
    if not candidates:
        return None
    return str(max(candidates, key=lambda row: _number(row.get(metric)) or 0).get(id_key) or "") or None


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _objective_question(objective: str) -> str:
    return {
        "evaluate_performance": "评估当前活动或片段的表现，并给出有数据依据的结论。",
        "explain_power_drop": "分析功率下降的时间位置、幅度及可能原因。",
        "analyze_hr_drift": "分析心率漂移，并结合功率、配速和地形说明证据边界。",
        "analyze_pacing": "分析前后程配速或功率分配。",
        "detect_intervals": "识别并评估活动中的主要间歇或冲刺段。",
    }.get(objective, "基于 FIT 数据回答当前活动问题。")


def _segment_candidates(
    scan: dict[str, Any], *, activity_id: str, requested_type: str,
) -> list[dict[str, Any]]:
    raw = scan.get("efforts") if isinstance(scan.get("efforts"), list) else []
    if requested_type == "climb":
        raw = scan.get("segments") if isinstance(scan.get("segments"), list) else []
    candidates: list[dict[str, Any]] = []
    for ordinal, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            continue
        detected_type = str(item.get("type") or "effort")
        if requested_type == "sprint" and float(item.get("duration_s") or 0) > 45:
            continue
        if requested_type == "fast_running_segment" and detected_type != "fast_running_segment":
            continue
        start_s = float(item.get("start_s") or 0)
        end_s = float(item.get("end_s") or 0)
        candidates.append({
            "segment_id": f"{activity_id or 'activity'}:{requested_type}:{ordinal}:{int(start_s)}-{int(end_s)}",
            "activity_id": activity_id,
            "segment_type": requested_type,
            "ordinal": ordinal,
            "start_seconds": start_s,
            "end_seconds": end_s,
            "duration_s": item.get("duration_s"),
            "avg_power_w": item.get("avg_power_w"),
            "max_power_w": item.get("max_power_w"),
            "avg_hr_bpm": item.get("avg_hr_bpm"),
            "max_hr_bpm": item.get("max_hr_bpm"),
            "avg_cadence_rpm": item.get("avg_cadence_rpm"),
            "avg_speed_kmh": item.get("avg_speed_kmh"),
            "detector": "cycling_power_sprint_v1" if requested_type == "sprint" else "activity_scan.v1",
            "confidence": item.get("score"),
        })
    return candidates


def _scan_from_stored_features(features: dict[str, Any], *, segment_type: str) -> dict[str, Any]:
    """Adapt import-time candidates to the existing segment selection shape."""
    sprint = _section(features, "sprint_candidates")
    efforts = _section(features, "effort_candidates")
    climbs = _section(features, "climb_candidates")
    if segment_type == "sprint":
        candidates = sprint.get("segments") if isinstance(sprint.get("segments"), list) else []
        return {
            "efforts": candidates,
            "summary": {"effort_count": int(sprint.get("count") or len(candidates))},
        }
    raw_efforts = efforts.get("efforts") if isinstance(efforts.get("efforts"), list) else []
    if segment_type == "fast_running_segment":
        raw_efforts = [item for item in raw_efforts if isinstance(item, dict) and item.get("type") == segment_type]
    if segment_type in {"interval", "effort"}:
        raw_efforts = [item for item in raw_efforts if isinstance(item, dict)]
    climb_segments = climbs.get("segments") if isinstance(climbs.get("segments"), list) else []
    return {
        "efforts": raw_efforts,
        "segments": climb_segments,
        "summary": efforts.get("summary") if isinstance(efforts.get("summary"), dict) else {},
    }


def _segment_ref(value: dict[str, Any]) -> SegmentRef:
    core_keys = {
        "segment_id", "activity_id", "segment_type", "ordinal", "start_seconds",
        "end_seconds", "detector", "confidence",
    }
    metrics = {key: item for key, item in value.items() if key not in core_keys}
    return SegmentRef(
        segment_id=str(value.get("segment_id") or ""),
        activity_id=str(value.get("activity_id") or ""),
        segment_type=str(value.get("segment_type") or "effort"),
        ordinal=int(value.get("ordinal") or 1),
        start_seconds=float(value.get("start_seconds") or 0),
        end_seconds=float(value.get("end_seconds") or 0),
        metrics=metrics,
        detector=str(value.get("detector") or "activity_scan.v1"),
        confidence=float(value["confidence"]) if value.get("confidence") is not None else None,
    )


def _fit_path(activity: dict[str, Any]) -> Path | None:
    value = activity.get("fit_path")
    path = Path(str(value)).expanduser() if value else None
    return path if path and path.is_file() else None
