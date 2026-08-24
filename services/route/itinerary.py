"""Verified multi-day and intra-day staged cycling itineraries."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any
from uuid import uuid4

from services.route.single_day import reverse_waypoint_queries, route_candidate, saved_waypoint_queries
from settings import load_config


PERIODS = {"full_day", "morning", "afternoon", "evening"}
SCHEDULE_TYPES = {"multi_day", "day_parts"}


def create_itinerary_plan(
    *,
    workspace_id: str,
    title: str,
    country_code: str,
    schedule_type: str,
    candidates: Sequence[dict[str, Any]],
    include_elevation: bool = True,
    handoff_tolerance_km: float = 5.0,
    balance_warning_ratio: float = 0.30,
    plan_id: str | None = None,
) -> dict[str, Any]:
    normalized_country = str(country_code or "").strip().upper()
    normalized_schedule = str(schedule_type or "").strip().lower()
    if not normalized_country:
        raise ValueError("country_code is required")
    if normalized_schedule not in SCHEDULE_TYPES:
        raise ValueError("schedule_type must be multi_day or day_parts")
    if not 1 <= len(candidates) <= 3:
        raise ValueError("one to three itinerary candidates are required")
    tolerance = _non_negative_float(handoff_tolerance_km, "handoff_tolerance_km")
    warning_ratio = _non_negative_float(balance_warning_ratio, "balance_warning_ratio")
    config = load_config()
    routed_candidates = [
        _route_itinerary_candidate(
            candidate,
            candidate_index=index,
            country_code=normalized_country,
            schedule_type=normalized_schedule,
            include_elevation=include_elevation,
            handoff_tolerance_km=tolerance,
            balance_warning_ratio=warning_ratio,
            config=config,
        )
        for index, candidate in enumerate(candidates, start=1)
    ]
    day_count = max(len(item.get("day_summaries") or []) for item in routed_candidates)
    return {
        "schema_version": "route_plan.v1",
        "plan_id": plan_id or f"route_{uuid4().hex}",
        "workspace_id": str(workspace_id),
        "revision": 0,
        "title": str(title or ("多日骑行路线" if normalized_schedule == "multi_day" else "单日分段路线")),
        "schedule_type": normalized_schedule,
        "day_count": day_count,
        "country_code": normalized_country,
        "handoff_tolerance_km": tolerance,
        "balance_warning_ratio": warning_ratio,
        "active_candidate_id": routed_candidates[0]["candidate_id"],
        "candidates": routed_candidates,
    }


def replace_itinerary_stage(
    plan: dict[str, Any],
    *,
    candidate_id: str | None,
    stage_id: str,
    label: str,
    waypoint_queries: Sequence[str],
    route_type: str,
    target_distance_km: float | None,
    include_elevation: bool,
) -> dict[str, Any]:
    candidates = [item for item in plan.get("candidates") or [] if isinstance(item, dict)]
    selected_id = str(candidate_id or plan.get("active_candidate_id") or "")
    candidate_index = next(
        (index for index, item in enumerate(candidates) if str(item.get("candidate_id") or "") == selected_id),
        -1,
    )
    if candidate_index < 0:
        raise ValueError("route candidate does not exist")
    selected = candidates[candidate_index]
    stages = [item for item in selected.get("stages") or [] if isinstance(item, dict)]
    stage_index = next(
        (index for index, item in enumerate(stages) if str(item.get("stage_id") or "") == str(stage_id or "")),
        -1,
    )
    if stage_index < 0:
        raise ValueError("itinerary stage does not exist")
    previous = stages[stage_index]
    spec = {
        "candidate_id": previous["stage_id"],
        "name": label or previous.get("label") or previous.get("name"),
        "waypoints": list(waypoint_queries),
        "route_type": route_type or previous.get("route_type") or "point_to_point",
        "target_distance_km": (
            target_distance_km
            if target_distance_km is not None
            else previous.get("target_distance_km")
        ),
    }
    routed = route_candidate(
        spec,
        index=stage_index + 1,
        country_code=str(plan.get("country_code") or ""),
        include_elevation=include_elevation,
        config=load_config(),
    )
    updated_stage = _stage_payload(
        routed,
        {**previous, "label": spec["name"]},
        stage_index + 1,
    )
    updated_stages = [updated_stage if index == stage_index else item for index, item in enumerate(stages)]
    updated_candidate = _finalize_candidate(
        {**selected, "stages": updated_stages},
        schedule_type=str(plan.get("schedule_type") or "multi_day"),
        handoff_tolerance_km=_plan_float(plan, "handoff_tolerance_km", 5.0),
        balance_warning_ratio=_plan_float(plan, "balance_warning_ratio", 0.30),
    )
    return {
        **plan,
        "candidates": [
            updated_candidate if index == candidate_index else item
            for index, item in enumerate(candidates)
        ],
    }


def edit_itinerary_stage_waypoints(
    plan: dict[str, Any],
    *,
    candidate_id: str | None,
    stage_id: str,
    operation: str,
    waypoint_index: int | None = None,
    new_waypoint: str | None = None,
    include_elevation: bool = True,
) -> dict[str, Any]:
    candidates = [item for item in plan.get("candidates") or [] if isinstance(item, dict)]
    selected_id = str(candidate_id or plan.get("active_candidate_id") or "")
    selected = next(
        (item for item in candidates if str(item.get("candidate_id") or "") == selected_id),
        None,
    )
    if selected is None:
        raise ValueError("route candidate does not exist")
    stage = next(
        (
            item for item in selected.get("stages") or []
            if isinstance(item, dict) and str(item.get("stage_id") or "") == str(stage_id or "")
        ),
        None,
    )
    if stage is None:
        raise ValueError("itinerary stage does not exist")
    queries = saved_waypoint_queries(stage)
    if operation == "reverse":
        queries = reverse_waypoint_queries(queries, str(stage.get("route_type") or "point_to_point"))
    elif operation == "replace_waypoint":
        if waypoint_index is None:
            raise ValueError("waypoint_index is required")
        index = int(waypoint_index) - 1
        if not 0 <= index < len(queries):
            raise ValueError(f"waypoint_index must be between 1 and {len(queries)}")
        replacement = str(new_waypoint or "").strip()
        if not replacement:
            raise ValueError("new_waypoint is required")
        queries[index] = replacement
    else:
        raise ValueError("operation must be reverse or replace_waypoint")
    return replace_itinerary_stage(
        plan,
        candidate_id=selected_id,
        stage_id=str(stage["stage_id"]),
        label=str(stage.get("label") or ""),
        waypoint_queries=queries,
        route_type=str(stage.get("route_type") or "point_to_point"),
        target_distance_km=stage.get("target_distance_km"),
        include_elevation=include_elevation,
    )


def refresh_itinerary_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Recompute staged aggregates after an external route enrichment."""
    schedule_type = str(plan.get("schedule_type") or "multi_day")
    candidates = [
        _finalize_candidate(
            candidate,
            schedule_type=schedule_type,
            handoff_tolerance_km=_plan_float(plan, "handoff_tolerance_km", 5.0),
            balance_warning_ratio=_plan_float(plan, "balance_warning_ratio", 0.30),
        )
        for candidate in plan.get("candidates") or [] if isinstance(candidate, dict)
    ]
    return {**plan, "candidates": candidates}


def _route_itinerary_candidate(
    candidate: dict[str, Any],
    *,
    candidate_index: int,
    country_code: str,
    schedule_type: str,
    include_elevation: bool,
    handoff_tolerance_km: float,
    balance_warning_ratio: float,
    config: dict[str, Any],
) -> dict[str, Any]:
    stage_specs = [item for item in candidate.get("stages") or [] if isinstance(item, dict)]
    if not 2 <= len(stage_specs) <= 7:
        raise ValueError("each itinerary candidate requires two to seven stages")
    normalized_specs = [
        _normalize_stage(spec, stage_index=index, candidate_index=candidate_index)
        for index, spec in enumerate(stage_specs, start=1)
    ]
    _validate_stage_order(normalized_specs)
    days = {int(item["day"]) for item in normalized_specs}
    if schedule_type == "multi_day" and len(days) < 2:
        raise ValueError("multi_day requires at least two distinct days")
    if schedule_type == "multi_day" and days != set(range(1, max(days) + 1)):
        raise ValueError("multi_day days must be consecutive and start at day 1")
    if schedule_type == "day_parts" and days != {1}:
        raise ValueError("day_parts stages must belong to day 1")
    routed_stages = []
    for index, spec in enumerate(normalized_specs, start=1):
        routed = route_candidate(
            {
                "candidate_id": spec["stage_id"],
                "name": spec["label"],
                "waypoints": spec["waypoints"],
                "route_type": spec["route_type"],
                "target_distance_km": spec.get("target_distance_km"),
            },
            index=index,
            country_code=country_code,
            include_elevation=include_elevation,
            config=config,
        )
        routed_stages.append(_stage_payload(routed, spec, index))
    return _finalize_candidate(
        {
            "candidate_id": str(candidate.get("candidate_id") or f"candidate_{candidate_index}"),
            "name": str(candidate.get("name") or f"候选行程 {candidate_index}"),
            "stages": routed_stages,
        },
        schedule_type=schedule_type,
        handoff_tolerance_km=handoff_tolerance_km,
        balance_warning_ratio=balance_warning_ratio,
    )


def _normalize_stage(spec: dict[str, Any], *, stage_index: int, candidate_index: int) -> dict[str, Any]:
    try:
        day = int(spec.get("day") or 1)
    except (TypeError, ValueError) as exc:
        raise ValueError("stage day must be a positive integer") from exc
    if day < 1:
        raise ValueError("stage day must be a positive integer")
    period = str(spec.get("period") or "full_day").strip().lower()
    if period not in PERIODS:
        raise ValueError("stage period must be full_day, morning, afternoon or evening")
    waypoints = [str(value).strip() for value in spec.get("waypoints") or [] if str(value).strip()]
    if len(waypoints) < 2:
        raise ValueError("each itinerary stage requires at least two waypoint queries")
    return {
        **spec,
        "stage_id": str(spec.get("stage_id") or f"stage_{candidate_index}_{stage_index}"),
        "label": str(spec.get("label") or _default_stage_label(day, period)),
        "day": day,
        "period": period,
        "waypoints": waypoints,
        "route_type": str(spec.get("route_type") or "point_to_point"),
    }


def _stage_payload(routed: dict[str, Any], metadata: dict[str, Any], stage_index: int) -> dict[str, Any]:
    payload = dict(routed)
    payload["stage_id"] = str(payload.pop("candidate_id", None) or metadata.get("stage_id") or f"stage_{stage_index}")
    payload["label"] = str(metadata.get("label") or payload.pop("name", None) or f"阶段 {stage_index}")
    payload.pop("name", None)
    payload["day"] = int(metadata.get("day") or 1)
    payload["period"] = str(metadata.get("period") or "full_day")
    return payload


def _finalize_candidate(
    candidate: dict[str, Any],
    *,
    schedule_type: str,
    handoff_tolerance_km: float,
    balance_warning_ratio: float,
) -> dict[str, Any]:
    stages = [dict(item) for item in candidate.get("stages") or [] if isinstance(item, dict)]
    for index, stage in enumerate(stages):
        stage["handoff_from_previous_km"] = 0.0
        if index == 0:
            continue
        previous_end = _endpoint(stages[index - 1], last=True)
        current_start = _endpoint(stage, last=False)
        gap_km = round(_distance_km(previous_end, current_start), 2)
        if gap_km > handoff_tolerance_km:
            raise ValueError(
                f"stage {index} end and stage {index + 1} start are {gap_km:.2f} km apart, "
                f"exceeding the {handoff_tolerance_km:.2f} km tolerance"
            )
        stage["handoff_from_previous_km"] = gap_km

    day_values = sorted({int(stage.get("day") or 1) for stage in stages})
    day_summaries = []
    for day in day_values:
        items = [stage for stage in stages if int(stage.get("day") or 1) == day]
        day_summaries.append({
            "day": day,
            "distance_km": round(sum(float(item.get("distance_km") or 0) for item in items), 1),
            "duration_min": sum(int(item.get("duration_min") or 0) for item in items),
            "stage_count": len(items),
        })
    distances = [float(item["distance_km"]) for item in day_summaries]
    average = sum(distances) / len(distances) if distances else 0.0
    maximum_deviation = max((abs(value - average) / average for value in distances), default=0.0) if average else 0.0
    warnings = [
        str(warning)
        for stage in stages
        for warning in stage.get("warnings") or []
        if str(warning)
    ]
    if schedule_type == "multi_day" and maximum_deviation > balance_warning_ratio:
        warnings.append(
            f"每日距离差异较大：最大偏差 {maximum_deviation:.0%}，"
            f"超过参考阈值 {balance_warning_ratio:.0%}。"
        )
    return {
        **candidate,
        "stages": stages,
        "day_summaries": day_summaries,
        "distance_m": sum(float(item.get("distance_m") or 0) for item in stages),
        "distance_km": round(sum(float(item.get("distance_km") or 0) for item in stages), 1),
        "duration_s": sum(float(item.get("duration_s") or 0) for item in stages),
        "duration_min": sum(int(item.get("duration_min") or 0) for item in stages),
        "maximum_day_distance_deviation_ratio": round(maximum_deviation, 3),
        "warnings": warnings,
    }


def _endpoint(stage: dict[str, Any], *, last: bool) -> tuple[float, float]:
    points = [item for item in stage.get("waypoints") or [] if isinstance(item, dict)]
    if not points:
        raise ValueError("itinerary stage has no resolved waypoints")
    point = points[-1] if last else points[0]
    return (
        float(point.get("display_latitude", point.get("latitude"))),
        float(point.get("display_longitude", point.get("longitude"))),
    )


def _distance_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, first)
    lat2, lon2 = map(math.radians, second)
    delta_lat, delta_lon = lat2 - lat1, lon2 - lon1
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6_371.0088 * 2 * math.asin(math.sqrt(value))


def _default_stage_label(day: int, period: str) -> str:
    period_label = {"morning": "上午", "afternoon": "下午", "evening": "晚上"}.get(period)
    return f"第 {day} 天{period_label or ''}"


def _validate_stage_order(stages: Sequence[dict[str, Any]]) -> None:
    period_order = {"full_day": 0, "morning": 0, "afternoon": 1, "evening": 2}
    keys = [(int(item["day"]), period_order[str(item["period"])]) for item in stages]
    if keys != sorted(keys):
        raise ValueError("itinerary stages must be ordered by day and period")


def _plan_float(plan: dict[str, Any], key: str, default: float) -> float:
    value = plan.get(key)
    return default if value is None else float(value)


def _non_negative_float(value: Any, name: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be numeric") from exc
    if parsed < 0:
        raise ValueError(f"{name} must not be negative")
    return parsed
