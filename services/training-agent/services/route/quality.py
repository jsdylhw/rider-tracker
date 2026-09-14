"""Deterministic quality checks for provider-resolved route geometry."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any


DEFAULT_MAXIMUM_SELF_OVERLAP_RATIO = 0.10
SAMPLE_LENGTH_METERS = 20.0
MATCH_DISTANCE_METERS = 12.0
MAXIMUM_HEADING_DIFFERENCE_DEGREES = 25.0
NEARBY_ROUTE_DISTANCE_METERS = 100.0
MAXIMUM_SHARED_ACCESS_METERS = 300.0
SHARED_ACCESS_ROUTE_RATIO = 0.03

ROUTING_PRIORITIES = {"balanced", "shortest", "fastest"}
TURN_BIASES = {"neutral", "fewer_left", "fewer_right", "fewer_turns"}
NAVIGATION_COMPLEXITIES = {"neutral", "simple"}
PASSAGE_LABELS = {
    "20": "stairs",
    "22": "bridge",
    "23": "tunnel",
    "30": "ferry",
}


def normalize_route_constraints(value: Any) -> dict[str, Any]:
    """Return the persisted route-constraint contract with validated bounds."""
    raw = value if isinstance(value, Mapping) else {}
    avoid_repeated = bool(raw.get("avoid_repeated_roads", False))
    maximum_ratio = raw.get(
        "maximum_self_overlap_ratio",
        DEFAULT_MAXIMUM_SELF_OVERLAP_RATIO,
    )
    try:
        maximum_ratio = float(maximum_ratio)
    except (TypeError, ValueError) as exc:
        raise ValueError("maximum_self_overlap_ratio must be a number") from exc
    if not 0.0 <= maximum_ratio <= 1.0:
        raise ValueError("maximum_self_overlap_ratio must be between 0 and 1")
    maximum_detour_ratio = _optional_ratio(raw, "maximum_detour_ratio")
    return {
        "avoid_repeated_roads": avoid_repeated,
        "maximum_self_overlap_ratio": maximum_ratio,
        "avoid_u_turns": bool(raw.get("avoid_u_turns", False)),
        "avoid_ferry": bool(raw.get("avoid_ferry", False)),
        "avoid_stairs": bool(raw.get("avoid_stairs", False)),
        "maximum_detour_ratio": maximum_detour_ratio,
    }


def normalize_route_preferences(value: Any) -> dict[str, Any]:
    """Normalize best-effort route ranking preferences separately from constraints."""
    raw = value if isinstance(value, Mapping) else {}
    routing_priority = str(raw.get("routing_priority") or "balanced").strip().lower()
    turn_bias = str(raw.get("turn_bias") or "neutral").strip().lower()
    navigation_complexity = str(raw.get("navigation_complexity") or "neutral").strip().lower()
    if routing_priority not in ROUTING_PRIORITIES:
        raise ValueError(f"routing_priority must be one of {sorted(ROUTING_PRIORITIES)}")
    if turn_bias not in TURN_BIASES:
        raise ValueError(f"turn_bias must be one of {sorted(TURN_BIASES)}")
    if navigation_complexity not in NAVIGATION_COMPLEXITIES:
        raise ValueError(
            f"navigation_complexity must be one of {sorted(NAVIGATION_COMPLEXITIES)}"
        )
    return {
        "routing_priority": routing_priority,
        "turn_bias": turn_bias,
        "navigation_complexity": navigation_complexity,
        "prefer_fewer_tunnels": bool(raw.get("prefer_fewer_tunnels", False)),
        "prefer_fewer_bridges": bool(raw.get("prefer_fewer_bridges", False)),
    }


def evaluate_navigation(steps: Sequence[Any], *, distance_m: float = 0.0) -> dict[str, Any]:
    """Build comparable evidence from provider navigation steps.

    Counts intentionally use provider actions rather than polyline angles.  A
    slight-left/right instruction therefore remains a directional maneuver,
    while a U-turn is counted only as a U-turn.
    """
    left_turns = right_turns = u_turns = unnamed_steps = 0
    passage_counts = {label: 0 for label in PASSAGE_LABELS.values()}
    normalized_steps = [item for item in steps if isinstance(item, Mapping)]
    for step in normalized_steps:
        action = str(step.get("action") or "").strip()
        instruction = str(step.get("instruction") or "").strip()
        maneuver = action or instruction
        if "掉头" in maneuver or "调头" in maneuver:
            u_turns += 1
        elif "左" in maneuver:
            left_turns += 1
        elif "右" in maneuver:
            right_turns += 1
        if not str(step.get("road_name") or step.get("road") or "").strip():
            unnamed_steps += 1
        passage = PASSAGE_LABELS.get(str(step.get("walk_type") or "").strip())
        if passage:
            passage_counts[passage] += 1
    significant_turns = left_turns + right_turns + u_turns
    distance_km = max(0.0, float(distance_m)) / 1000.0
    return {
        "navigation_data_source": "amap_navigation" if normalized_steps else "unavailable",
        "navigation_step_count": len(normalized_steps),
        "left_turn_count": left_turns,
        "right_turn_count": right_turns,
        "u_turn_count": u_turns,
        "significant_turn_count": significant_turns,
        "steps_per_km": round(len(normalized_steps) / distance_km, 2) if distance_km else None,
        "unnamed_step_ratio": round(unnamed_steps / len(normalized_steps), 4) if normalized_steps else None,
        "passage_counts": passage_counts,
    }


def preference_score(
    candidate: Mapping[str, Any],
    preferences: Mapping[str, Any] | None,
    *,
    baseline_distance_m: float | None = None,
    baseline_duration_s: float | None = None,
) -> float:
    """Return a deterministic lower-is-better score for provider alternatives."""
    normalized = normalize_route_preferences(preferences)
    quality = candidate.get("route_quality") if isinstance(candidate.get("route_quality"), Mapping) else {}
    distance = max(0.0, float(candidate.get("distance_m") or 0.0))
    duration = max(0.0, float(candidate.get("duration_s") or 0.0))
    baseline_distance = max(1.0, float(
        baseline_distance_m
        if baseline_distance_m is not None
        else candidate.get("baseline_distance_m") or distance or 1.0
    ))
    baseline_duration = max(1.0, float(
        baseline_duration_s
        if baseline_duration_s is not None
        else candidate.get("baseline_duration_s") or duration or 1.0
    ))
    detour = max(0.0, distance / baseline_distance - 1.0)
    delay = max(0.0, duration / baseline_duration - 1.0)

    priority = normalized["routing_priority"]
    score = (
        detour * 100.0 if priority == "shortest"
        else delay * 100.0 if priority == "fastest"
        else detour * 35.0 + delay * 35.0
    )
    turn_bias = normalized["turn_bias"]
    if turn_bias == "fewer_left":
        score += float(quality.get("left_turn_count") or 0) * 4.0
    elif turn_bias == "fewer_right":
        score += float(quality.get("right_turn_count") or 0) * 4.0
    elif turn_bias == "fewer_turns":
        score += float(quality.get("significant_turn_count") or 0) * 3.0
    if normalized["navigation_complexity"] == "simple":
        score += float(quality.get("significant_turn_count") or 0) * 2.0
        score += float(quality.get("steps_per_km") or 0) * 2.0
        score += float(quality.get("unnamed_step_ratio") or 0) * 5.0
    passage_counts = quality.get("passage_counts") if isinstance(quality.get("passage_counts"), Mapping) else {}
    if normalized["prefer_fewer_tunnels"]:
        score += float(passage_counts.get("tunnel") or 0) * 8.0
    if normalized["prefer_fewer_bridges"]:
        score += float(passage_counts.get("bridge") or 0) * 4.0
    return round(score, 4)


def evaluate_self_overlap(coordinates: Sequence[Any]) -> dict[str, Any]:
    """Estimate excess traversal over the same road from a LineString.

    Geometry is resampled into short segments. A later segment counts as
    repeated when its midpoint is close to an earlier, non-adjacent segment and
    their headings are parallel in either direction. Perpendicular crossings
    therefore do not count. A small start/end access section is ignored so a
    loop may share the street leaving and returning to its origin.
    """
    points = _project_coordinates(coordinates)
    samples = _resample(points)
    total_distance = sum(item[4] for item in samples)
    if total_distance <= 0.0:
        return {
            "self_overlap_ratio": 0.0,
            "repeated_distance_m": 0.0,
            "geometry_distance_m": 0.0,
        }

    cell_size = MATCH_DISTANCE_METERS
    grid: dict[tuple[int, int], list[int]] = {}
    repeated_distance = 0.0
    heading_threshold = math.cos(math.radians(MAXIMUM_HEADING_DIFFERENCE_DEGREES))
    shared_access = min(MAXIMUM_SHARED_ACCESS_METERS, total_distance * SHARED_ACCESS_ROUTE_RATIO)

    for index, sample in enumerate(samples):
        midpoint_x, midpoint_y, unit_x, unit_y, length, route_midpoint = sample
        cell = (math.floor(midpoint_x / cell_size), math.floor(midpoint_y / cell_size))
        matched = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for prior_index in grid.get((cell[0] + dx, cell[1] + dy), []):
                    prior = samples[prior_index]
                    if route_midpoint - prior[5] <= NEARBY_ROUTE_DISTANCE_METERS:
                        continue
                    # Permit only the short common access road immediately at
                    # the beginning and end of a loop.
                    if prior[5] <= shared_access and route_midpoint >= total_distance - shared_access:
                        continue
                    distance = math.hypot(midpoint_x - prior[0], midpoint_y - prior[1])
                    parallel = abs(unit_x * prior[2] + unit_y * prior[3]) >= heading_threshold
                    if distance <= MATCH_DISTANCE_METERS and parallel:
                        matched = True
                        break
                if matched:
                    break
            if matched:
                break
        if matched:
            # Only the later traversal is excess distance. This avoids counting
            # both the outbound and return copies of an out-and-back section.
            repeated_distance += length
        grid.setdefault(cell, []).append(index)

    return {
        "self_overlap_ratio": round(repeated_distance / total_distance, 4),
        "repeated_distance_m": round(repeated_distance, 1),
        "geometry_distance_m": round(total_distance, 1),
    }


def apply_route_constraints(
    candidate: dict[str, Any],
    constraints: Mapping[str, Any] | None,
    *,
    rejection_type: type[ValueError] = ValueError,
) -> dict[str, Any]:
    """Attach quality evidence and reject a candidate that breaks constraints."""
    normalized = normalize_route_constraints(constraints)
    geometry = candidate.get("geometry") if isinstance(candidate.get("geometry"), dict) else {}
    coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
    existing_quality = (
        candidate.get("route_quality")
        if isinstance(candidate.get("route_quality"), Mapping) else {}
    )
    quality = {
        **existing_quality,
        **evaluate_self_overlap(coordinates),
        **evaluate_navigation(
            candidate.get("navigation_steps") or [],
            distance_m=float(candidate.get("distance_m") or 0),
        ),
    }
    baseline_distance = float(candidate.get("baseline_distance_m") or 0)
    distance = float(candidate.get("distance_m") or 0)
    quality["detour_ratio"] = (
        round(max(0.0, distance / baseline_distance - 1.0), 4)
        if baseline_distance > 0 and distance > 0 else None
    )
    updated = {**candidate, "route_quality": quality}
    if (
        normalized["avoid_repeated_roads"]
        and quality["self_overlap_ratio"] > normalized["maximum_self_overlap_ratio"]
    ):
        actual = float(quality["self_overlap_ratio"])
        maximum = float(normalized["maximum_self_overlap_ratio"])
        raise rejection_type(
            f"路线自身重复率 {actual:.1%}，超过允许上限 {maximum:.1%}；请更换途经点后重新算路"
        )
    navigation_required = any(
        normalized[key] for key in ("avoid_u_turns", "avoid_ferry", "avoid_stairs")
    )
    if navigation_required and quality["navigation_data_source"] == "unavailable":
        raise rejection_type("路线没有高德导航步骤，无法验证掉头、轮渡或阶梯约束")
    if normalized["avoid_u_turns"] and quality["u_turn_count"] > 0:
        raise rejection_type(f"路线包含 {quality['u_turn_count']} 次掉头；请改用其他高德备选路线")
    passage_counts = quality["passage_counts"]
    if normalized["avoid_ferry"] and passage_counts["ferry"] > 0:
        raise rejection_type("路线包含轮渡路段；请改用其他高德备选路线")
    if normalized["avoid_stairs"] and passage_counts["stairs"] > 0:
        raise rejection_type("路线包含阶梯路段；请改用其他高德备选路线")
    maximum_detour = normalized["maximum_detour_ratio"]
    if maximum_detour is not None and quality["detour_ratio"] is None:
        raise rejection_type("路线缺少相同途经点的最短高德备选，无法验证绕行比例")
    if maximum_detour is not None and quality["detour_ratio"] > maximum_detour:
        raise rejection_type(
            f"路线比同一途经点的最短高德备选多绕行 {quality['detour_ratio']:.1%}，"
            f"超过允许上限 {maximum_detour:.1%}"
        )
    return updated


def _optional_ratio(raw: Mapping[str, Any], key: str) -> float | None:
    value = raw.get(key)
    if value is None:
        return None
    try:
        ratio = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be a number") from exc
    if not 0.0 <= ratio <= 1.0:
        raise ValueError(f"{key} must be between 0 and 1")
    return ratio


def apply_plan_route_constraints(
    plan: dict[str, Any],
    constraints: Mapping[str, Any] | None,
    *,
    candidate_id: str | None = None,
    rejection_type: type[ValueError] = ValueError,
) -> dict[str, Any]:
    """Validate candidate geometry after provider or segment composition."""
    normalized = normalize_route_constraints(constraints)
    candidates = []
    for candidate in plan.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        should_check = not candidate_id or str(candidate.get("candidate_id") or "") == candidate_id
        candidates.append(
            apply_route_constraints(candidate, normalized, rejection_type=rejection_type)
            if should_check else candidate
        )
    return {**plan, "route_constraints": normalized, "candidates": candidates}


def filter_plan_route_constraints(
    plan: dict[str, Any],
    constraints: Mapping[str, Any] | None,
    *,
    rejection_type: type[ValueError] = ValueError,
) -> dict[str, Any]:
    """Drop only invalid alternatives while retaining compliant candidates."""
    normalized = normalize_route_constraints(constraints)
    accepted: list[dict[str, Any]] = []
    rejected = [item for item in plan.get("rejected_candidates") or [] if isinstance(item, dict)]
    for candidate in plan.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        try:
            accepted.append(apply_route_constraints(
                candidate,
                normalized,
                rejection_type=rejection_type,
            ))
        except rejection_type as exc:
            rejected.append({
                "name": str(candidate.get("name") or "未命名候选"),
                "reason": str(exc),
            })
    if not accepted:
        reasons = "；".join(f"{item['name']}：{item['reason']}" for item in rejected)
        raise rejection_type(f"所有路线候选均不可用。{reasons}")
    active_id = str(plan.get("active_candidate_id") or "")
    if not any(str(item.get("candidate_id") or "") == active_id for item in accepted):
        active_id = str(accepted[0].get("candidate_id") or "")
    return {
        **plan,
        "route_constraints": normalized,
        "active_candidate_id": active_id,
        "candidates": accepted,
        "rejected_candidates": rejected,
    }


def _project_coordinates(coordinates: Sequence[Any]) -> list[tuple[float, float]]:
    parsed: list[tuple[float, float]] = []
    for value in coordinates:
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) < 2:
            continue
        try:
            longitude, latitude = float(value[0]), float(value[1])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(longitude) or not math.isfinite(latitude):
            continue
        if parsed and parsed[-1] == (longitude, latitude):
            continue
        parsed.append((longitude, latitude))
    if not parsed:
        return []
    latitude_origin = math.radians(sum(point[1] for point in parsed) / len(parsed))
    meters_per_longitude_degree = 111_320.0 * max(0.01, math.cos(latitude_origin))
    return [
        (longitude * meters_per_longitude_degree, latitude * 110_540.0)
        for longitude, latitude in parsed
    ]


def _resample(points: Sequence[tuple[float, float]]) -> list[tuple[float, float, float, float, float, float]]:
    samples: list[tuple[float, float, float, float, float, float]] = []
    route_distance = 0.0
    for start, end in zip(points, points[1:]):
        delta_x, delta_y = end[0] - start[0], end[1] - start[1]
        segment_length = math.hypot(delta_x, delta_y)
        if segment_length < 0.5:
            continue
        pieces = max(1, math.ceil(segment_length / SAMPLE_LENGTH_METERS))
        piece_length = segment_length / pieces
        unit_x, unit_y = delta_x / segment_length, delta_y / segment_length
        for piece in range(pieces):
            fraction = (piece + 0.5) / pieces
            midpoint_x = start[0] + delta_x * fraction
            midpoint_y = start[1] + delta_y * fraction
            samples.append((
                midpoint_x,
                midpoint_y,
                unit_x,
                unit_y,
                piece_length,
                route_distance + piece_length * 0.5,
            ))
            route_distance += piece_length
    return samples
