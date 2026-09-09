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
    return {
        "avoid_repeated_roads": avoid_repeated,
        "maximum_self_overlap_ratio": maximum_ratio,
    }


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
    quality = evaluate_self_overlap(coordinates)
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
    return updated


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
