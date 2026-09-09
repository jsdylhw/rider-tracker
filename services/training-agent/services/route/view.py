"""Bounded Rider-facing projection of persisted route plans."""

from __future__ import annotations

from math import isfinite
from typing import Any

from domain.contracts.schemas import ROUTE_PLAN_VIEW_V1


MAX_GEOMETRY_POINTS = 2000


def build_route_plan_view(plan: dict[str, Any]) -> dict[str, Any]:
    planning = plan.get("planning") if isinstance(plan.get("planning"), dict) else {}
    candidates = [
        projected
        for item in plan.get("candidates") or []
        if isinstance(item, dict)
        for projected in [_candidate_view(item)]
        if projected is not None
    ]
    return {
        "schema_version": ROUTE_PLAN_VIEW_V1,
        "plan_id": str(plan.get("plan_id") or ""),
        "revision": int(plan.get("revision") or 0),
        "title": str(plan.get("title") or ""),
        "schedule_type": str(plan.get("schedule_type") or "single_day"),
        "country_code": str(plan.get("country_code") or "") or None,
        "planning_status": str(planning.get("status") or "awaiting_selection"),
        "active_candidate_id": str(plan.get("active_candidate_id") or "") or None,
        "confirmed_candidate_id": str(planning.get("confirmed_candidate_id") or "") or None,
        "candidates": candidates,
        "segments": _segment_catalog(plan),
    }


def _candidate_view(candidate: dict[str, Any]) -> dict[str, Any] | None:
    candidate_id = str(candidate.get("candidate_id") or "")
    if not candidate_id:
        return None
    stages = [
        projected
        for item in candidate.get("stages") or []
        if isinstance(item, dict)
        for projected in [_stage_view(item)]
        if projected is not None
    ]
    return {
        "candidate_id": candidate_id,
        "parent_candidate_id": str(candidate.get("parent_candidate_id") or "") or None,
        "name": str(candidate.get("name") or candidate_id),
        "distance_m": _meters(candidate.get("distance_m"), candidate.get("distance_km")),
        "provider_duration_s": _seconds(candidate.get("duration_s"), candidate.get("duration_min")),
        "provider": str(candidate.get("provider") or "") or None,
        "travel_mode": str(candidate.get("travel_mode") or "") or None,
        "is_closed": bool(candidate.get("is_closed") or candidate.get("route_type") == "loop"),
        "geometry": _geometry(candidate.get("geometry")),
        "waypoints": _waypoints(candidate.get("waypoints")),
        "segment_sequence": _segment_sequence(candidate.get("strava_segments")),
        "stages": stages,
        "warnings": [str(value) for value in candidate.get("warnings") or [] if str(value)],
    }


def _stage_view(stage: dict[str, Any]) -> dict[str, Any] | None:
    stage_id = str(stage.get("stage_id") or "")
    if not stage_id:
        return None
    return {
        "stage_id": stage_id,
        "label": str(stage.get("label") or stage_id),
        "distance_m": _meters(stage.get("distance_m"), stage.get("distance_km")),
        "provider_duration_s": _seconds(stage.get("duration_s"), stage.get("duration_min")),
        "geometry": _geometry(stage.get("geometry")),
        "waypoints": _waypoints(stage.get("waypoints")),
        "segment_sequence": _segment_sequence(stage.get("strava_segments")),
    }


def _segment_catalog(plan: dict[str, Any]) -> list[dict[str, Any]]:
    pools = plan.get("segment_pool") if isinstance(plan.get("segment_pool"), dict) else {}
    target_candidates = _segment_target_candidates(plan)
    catalog: dict[int, dict[str, Any]] = {}
    for target_id, values in pools.items():
        for segment in values if isinstance(values, list) else []:
            if not isinstance(segment, dict):
                continue
            segment_id = _positive_int(segment.get("segment_id"))
            if segment_id is None:
                continue
            current = catalog.setdefault(segment_id, {
                "segment_id": segment_id,
                "name": str(segment.get("name") or segment_id),
                "sport_type": str(segment.get("sport_type") or "Ride"),
                "distance_m": _meters(segment.get("distance_m"), segment.get("distance_km")),
                "average_grade_percent": _number(segment.get("average_grade_percent")),
                "maximum_grade_percent": _number(segment.get("maximum_grade_percent")),
                "elevation_difference_m": _number(segment.get("elevation_difference_m")),
                "distance_to_route_m": _meters(None, segment.get("distance_to_route_km")),
                "route_overlap_ratio": _number(segment.get("route_overlap_ratio")),
                "candidate_ids": [],
                "geometry": _geometry(segment.get("geometry")),
            })
            target = target_candidates.get(str(target_id), str(target_id))
            if target and target not in current["candidate_ids"]:
                current["candidate_ids"].append(target)
    return list(catalog.values())


def _segment_target_candidates(plan: dict[str, Any]) -> dict[str, str]:
    targets: dict[str, str] = {}
    for candidate in plan.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        candidate_id = str(candidate.get("candidate_id") or "")
        if not candidate_id:
            continue
        targets[candidate_id] = candidate_id
        for stage in candidate.get("stages") or []:
            if isinstance(stage, dict) and stage.get("stage_id"):
                targets[str(stage["stage_id"])] = candidate_id
    return targets


def _segment_sequence(values: Any) -> list[dict[str, Any]]:
    sequence = []
    for index, segment in enumerate(values if isinstance(values, list) else [], start=1):
        if not isinstance(segment, dict):
            continue
        segment_id = _positive_int(segment.get("segment_id"))
        if segment_id is None:
            continue
        sequence.append({
            "segment_id": segment_id,
            "order": index,
            "direction": str(segment.get("direction") or "auto"),
            "role": str(segment.get("role") or "included"),
        })
    return sequence


def _waypoints(values: Any) -> list[dict[str, Any]]:
    points = []
    for index, point in enumerate(values if isinstance(values, list) else [], start=1):
        if not isinstance(point, dict):
            continue
        points.append({
            "waypoint_id": str(point.get("waypoint_id") or f"waypoint_{index}"),
            "name": str(point.get("name") or point.get("query") or ""),
            "query": str(point.get("query") or point.get("name") or ""),
            "latitude": _number(point.get("display_latitude", point.get("latitude"))),
            "longitude": _number(point.get("display_longitude", point.get("longitude"))),
        })
    return points


def _geometry(value: Any) -> dict[str, Any] | None:
    geometry = value if isinstance(value, dict) else {}
    coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
    valid = []
    for coordinate in coordinates:
        if not isinstance(coordinate, (list, tuple)) or len(coordinate) < 2:
            continue
        longitude, latitude = _number(coordinate[0]), _number(coordinate[1])
        if longitude is None or latitude is None or abs(longitude) > 180 or abs(latitude) > 90:
            continue
        valid.append([longitude, latitude])
    if len(valid) < 2:
        return None
    if len(valid) > MAX_GEOMETRY_POINTS:
        indices = [round(i * (len(valid) - 1) / (MAX_GEOMETRY_POINTS - 1)) for i in range(MAX_GEOMETRY_POINTS)]
        valid = [valid[index] for index in dict.fromkeys(indices)]
    return {"type": "LineString", "coordinates": valid}


def _meters(value_m: Any, value_km: Any) -> float | None:
    direct = _number(value_m)
    return direct if direct is not None else ((_number(value_km) or 0) * 1000 if _number(value_km) is not None else None)


def _seconds(value_s: Any, value_min: Any) -> float | None:
    direct = _number(value_s)
    return direct if direct is not None else ((_number(value_min) or 0) * 60 if _number(value_min) is not None else None)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None
