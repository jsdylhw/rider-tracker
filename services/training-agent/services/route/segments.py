"""Strava Segment enrichment for persisted route plans."""

from __future__ import annotations

import math
from copy import deepcopy
from typing import Any, Callable, Sequence

from demo.osm_cycling_router.strava_segments import decode_polyline, explore_segments


SegmentExplorer = Callable[[str, str], dict[str, Any]]


def enrich_route_plan_with_segments(
    plan: dict[str, Any],
    *,
    access_token: str,
    candidate_id: str | None = None,
    stage_id: str | None = None,
    corridor_km: float = 5.0,
    max_segments: int = 12,
    explorer: SegmentExplorer | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Discover popular riding Segments near one saved route candidate.

    Explorer is a popularity-ranked bounded sample, not a complete road graph.
    The returned geometries are therefore persisted as route context only and
    never replace the provider-verified route geometry.
    """
    if not str(access_token or "").strip():
        raise ValueError("Strava access token is required")
    try:
        corridor = float(corridor_km)
    except (TypeError, ValueError) as exc:
        raise ValueError("corridor_km must be a number") from exc
    if not 0.1 <= corridor <= 20:
        raise ValueError("corridor_km must be between 0.1 and 20")
    if not 1 <= int(max_segments) <= 20:
        raise ValueError("max_segments must be between 1 and 20")

    updated = deepcopy(plan)
    candidates = [item for item in updated.get("candidates") or [] if isinstance(item, dict)]
    selected_id = str(candidate_id or updated.get("active_candidate_id") or "")
    selected = next(
        (item for item in candidates if str(item.get("candidate_id") or "") == selected_id),
        None,
    )
    if selected is None:
        raise ValueError("route candidate does not exist")
    targets = _route_targets(selected, stage_id=stage_id)
    fetch = explorer or explore_segments
    discovered: dict[int, dict[str, Any]] = {}
    target_metadata: list[dict[str, Any]] = []

    for target in targets:
        route_geometry = _line_coordinates(target.get("geometry"))
        bounds = _padded_bounds(route_geometry, corridor)
        sample = fetch(bounds, access_token)
        target_key = str(target.get("stage_id") or selected_id)
        target_label = str(target.get("label") or selected.get("name") or "当前路线")
        target_metadata.append({
            "target_id": target_key,
            "target_label": target_label,
            "bounds_wgs84": [float(value) for value in bounds.split(",")],
            "sample_count": len(sample.get("segments") or []),
        })
        for source_rank, raw in enumerate(sample.get("segments") or [], start=1):
            normalized = _normalize_segment(
                raw,
                route_geometry=route_geometry,
                corridor_km=corridor,
                target_id=target_key,
                target_label=target_label,
                source_rank=source_rank,
            )
            if normalized is None:
                continue
            segment_id = int(normalized["segment_id"])
            previous = discovered.get(segment_id)
            if previous is None or _rank_key(normalized) < _rank_key(previous):
                discovered[segment_id] = normalized

    selected_segments = sorted(discovered.values(), key=_rank_key)[: int(max_segments)]
    selected_ids = {int(item["segment_id"]) for item in selected_segments}
    segment_pool = dict(updated.get("segment_pool") or {}) if isinstance(updated.get("segment_pool"), dict) else {}
    for target in targets:
        target_key = str(target.get("stage_id") or selected_id)
        target["strava_segments"] = [
            item for item in selected_segments
            if int(item["segment_id"]) in selected_ids and item["target_id"] == target_key
        ]
        target["strava_segment_discovery"] = {
            "source": "strava_segments_explore",
            "corridor_km": corridor,
            "segment_count": len(target["strava_segments"]),
            "discovery_limit": "Strava Explorer returns a popularity-ranked sample, not every nearby segment.",
        }
        segment_pool[target_key] = [dict(item) for item in target["strava_segments"]]
    updated["segment_pool"] = segment_pool

    compact_segments = [
        {key: value for key, value in item.items() if key != "geometry"}
        for item in selected_segments
    ]
    result = {
        "kind": "route_segment_discovery",
        "plan_id": updated.get("plan_id"),
        "candidate_id": selected_id,
        "stage_id": str(stage_id or "") or None,
        "corridor_km": corridor,
        "segment_count": len(compact_segments),
        "targets": target_metadata,
        "segments": compact_segments,
        "discovery_limit": "Strava Explorer returns a popularity-ranked sample, not every nearby segment.",
    }
    return updated, result


def _route_targets(candidate: dict[str, Any], *, stage_id: str | None) -> list[dict[str, Any]]:
    stages = [item for item in candidate.get("stages") or [] if isinstance(item, dict)]
    if not stages:
        if stage_id:
            raise ValueError("stage_id is only valid for a staged itinerary")
        return [candidate]
    if not stage_id:
        return stages
    selected = next(
        (item for item in stages if str(item.get("stage_id") or "") == str(stage_id)),
        None,
    )
    if selected is None:
        raise ValueError("itinerary stage does not exist")
    return [selected]


def _line_coordinates(geometry: Any) -> list[list[float]]:
    value = geometry if isinstance(geometry, dict) else {}
    coordinates = [
        [float(point[0]), float(point[1])]
        for point in value.get("coordinates") or []
        if isinstance(point, (list, tuple)) and len(point) >= 2
    ]
    if value.get("type") != "LineString" or len(coordinates) < 2:
        raise ValueError("saved route has no usable LineString geometry")
    return coordinates


def _padded_bounds(coordinates: Sequence[Sequence[float]], corridor_km: float) -> str:
    latitudes = [float(point[1]) for point in coordinates]
    longitudes = [float(point[0]) for point in coordinates]
    center_lat = sum(latitudes) / len(latitudes)
    lat_padding = corridor_km / 111.0
    lon_padding = corridor_km / max(20.0, 111.0 * math.cos(math.radians(center_lat)))
    return ",".join(f"{value:.6f}" for value in (
        max(-90.0, min(latitudes) - lat_padding),
        max(-180.0, min(longitudes) - lon_padding),
        min(90.0, max(latitudes) + lat_padding),
        min(180.0, max(longitudes) + lon_padding),
    ))


def _normalize_segment(
    raw: Any,
    *,
    route_geometry: Sequence[Sequence[float]],
    corridor_km: float,
    target_id: str,
    target_label: str,
    source_rank: int,
) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    try:
        segment_id = int(raw["id"])
    except (KeyError, TypeError, ValueError):
        return None
    geometry = _segment_geometry(raw)
    if len(geometry) < 2:
        return None
    route_points = _bounded_points(route_geometry, limit=400)
    segment_points = _bounded_points(geometry, limit=120)
    distances = [
        min(_haversine_km(point, route_point) for route_point in route_points)
        for point in segment_points
    ]
    minimum = min(distances)
    if minimum > corridor_km:
        return None
    overlap_ratio = sum(distance <= corridor_km for distance in distances) / len(distances)
    start_index = _nearest_route_index(segment_points[0], route_points)
    end_index = _nearest_route_index(segment_points[-1], route_points)
    center_index = _nearest_route_index(segment_points[len(segment_points) // 2], route_points)
    return {
        "segment_id": segment_id,
        "name": str(raw.get("name") or f"Strava Segment {segment_id}"),
        "target_id": target_id,
        "target_label": target_label,
        "distance_km": round(float(raw.get("distance") or 0) / 1000, 2),
        "average_grade_percent": _optional_float(raw.get("avg_grade")),
        "elevation_difference_m": _optional_float(raw.get("elev_difference")),
        "climb_category": raw.get("climb_category_desc") or raw.get("climb_category"),
        "distance_to_route_km": round(minimum, 2),
        "route_overlap_ratio": round(overlap_ratio, 2),
        "route_position_ratio": round(center_index / max(1, len(route_points) - 1), 4),
        "suggested_direction": "forward" if end_index >= start_index else "reverse",
        "source_rank": source_rank,
        "starred": bool(raw.get("starred")),
        "geometry": {"type": "LineString", "coordinates": geometry},
    }


def _segment_geometry(raw: dict[str, Any]) -> list[list[float]]:
    encoded = str(raw.get("points") or "").strip()
    if encoded:
        try:
            return decode_polyline(encoded)
        except ValueError:
            pass
    points = []
    for key in ("start_latlng", "end_latlng"):
        value = raw.get(key)
        if isinstance(value, (list, tuple)) and len(value) >= 2:
            points.append([float(value[1]), float(value[0])])
    return points


def _rank_key(item: dict[str, Any]) -> tuple[float, float, int]:
    return (
        -float(item.get("route_overlap_ratio") or 0),
        float(item.get("distance_to_route_km") or 0),
        int(item.get("source_rank") or 0),
    )


def _nearest_route_index(point: Sequence[float], route_points: Sequence[Sequence[float]]) -> int:
    return min(
        range(len(route_points)),
        key=lambda index: _haversine_km(point, route_points[index]),
    )


def _bounded_points(value: Sequence[Sequence[float]], *, limit: int) -> list[list[float]]:
    points = [[float(point[0]), float(point[1])] for point in value]
    if len(points) <= limit:
        return points
    step = (len(points) - 1) / (limit - 1)
    return [points[round(index * step)] for index in range(limit)]


def _haversine_km(first: Sequence[float], second: Sequence[float]) -> float:
    lon1, lat1 = math.radians(float(first[0])), math.radians(float(first[1]))
    lon2, lat2 = math.radians(float(second[0])), math.radians(float(second[1]))
    delta_lon, delta_lat = lon2 - lon1, lat2 - lat1
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6371.0088 * 2 * math.atan2(math.sqrt(value), math.sqrt(max(0.0, 1 - value)))


def _optional_float(value: Any) -> float | None:
    try:
        return round(float(value), 1) if value is not None else None
    except (TypeError, ValueError):
        return None
