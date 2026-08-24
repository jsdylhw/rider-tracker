"""Bridge existing route-composition algorithms to the AMap cycling adapter."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from demo.osm_cycling_router.router import Point
from demo.osm_cycling_router.segment_loop import ConnectorFetcher, DirectedSegment, LoopCandidate, haversine_m, plan_ordered_segment_route

from .amap import AmapCyclingRouter, AmapPoint
from .coordinates import wgs84_to_gcj02


def wgs84_point_to_amap(point: Point) -> AmapPoint:
    lon, lat = wgs84_to_gcj02(point.lon, point.lat)
    return AmapPoint(lat, lon)


def amap_connector_fetcher(router: AmapCyclingRouter) -> ConnectorFetcher:
    """Make AMap pairwise cycling directions usable by ``segment_loop``."""
    def fetch(origin: Point, destination: Point) -> dict[str, Any]:
        # The planner receives GCJ-02 points after ``segments_to_gcj02`` below.
        result = router.route(AmapPoint(origin.lat, origin.lon), AmapPoint(destination.lat, destination.lon))
        return {
            **result,
            "raw": {"paths": [{"points": {"coordinates": result["geometry"]}}]},
            "details": {"provider": "amap", "mode": "bicycling"},
        }
    return fetch


def segments_to_gcj02(segments: Sequence[DirectedSegment]) -> list[DirectedSegment]:
    """Convert imported WGS-84 Strava/OSM skeletons once for AMap routing/rendering."""
    converted: list[DirectedSegment] = []
    for segment in segments:
        geometry = tuple(wgs84_to_gcj02(lon, lat) for lon, lat in segment.geometry)
        converted.append(DirectedSegment(
            segment_id=segment.segment_id,
            name=segment.name,
            geometry=geometry,
            distance_m=segment.distance_m,
            ascend_m=segment.ascend_m,
            properties={**segment.properties, "source_coordinate_system": "wgs84", "coordinate_system": "gcj02"},
        ))
    return converted


def plan_ordered_wgs84_segments_with_amap(
    segments: Sequence[DirectedSegment],
    *,
    start: Point,
    target_distance_m: float,
    router: AmapCyclingRouter,
    start_name: str = "指定起终点",
    near_handoff_m: float = 0.0,
) -> LoopCandidate:
    """Run the current ordered skeleton algorithm with AMap cycling connectors.

    Input segment geometries and ``start`` are WGS-84.  The output candidate is
    GCJ-02 and can be drawn directly on a high-map JS API base map.
    """
    gcj_start = wgs84_point_to_amap(start)
    return plan_ordered_segment_route(
        segments_to_gcj02(segments),
        start=Point(gcj_start.lat, gcj_start.lon),
        target_distance_m=target_distance_m,
        profile="amap_bicycling",
        connector_fetcher=amap_connector_fetcher(router),
        start_name=start_name,
        near_handoff_m=near_handoff_m,
    )


def candidate_preview_feature(
    candidate: LoopCandidate,
    *,
    index: int,
    name: str,
    min_distance_m: float,
    max_distance_m: float,
) -> dict[str, Any]:
    """Serialize one provider-validated route-book candidate for the AMap UI.

    It combines its individual Strava skeleton and AMap connector legs only
    for display.  ``within_requested_distance`` is intentionally separate
    from landmark-evidence validity: a navigable loop is not automatically a
    verified "环湖" route.
    """
    coordinates: list[list[float]] = []

    def append(geometry: Sequence[tuple[float, float]]) -> None:
        for lon, lat in geometry:
            point = [lon, lat]
            if not coordinates or coordinates[-1] != point:
                coordinates.append(point)

    if candidate.entry_connector:
        append(candidate.entry_connector.geometry)
    for segment, connector in zip(candidate.segments, candidate.connectors):
        append(segment.geometry)
        append(connector.geometry)
    if len(coordinates) < 2:
        raise ValueError("candidate has insufficient display geometry")
    closure_gap_m = haversine_m(coordinates[0], coordinates[-1])
    within_distance = min_distance_m <= candidate.total_distance_m <= max_distance_m
    palette = ("#2679ce", "#e46042", "#8e62c7", "#e0a62b", "#2e9d68")
    return {
        "type": "Feature",
        "properties": {
            "kind": "amap_bicycling_candidate",
            "name": f"候选 {index} · {name}",
            "color": palette[(index - 1) % len(palette)],
            "distance_m": round(candidate.total_distance_m, 1),
            "connector_distance_m": round(candidate.connector_distance_m, 1),
            "retrace_ratio": round(candidate.retrace_ratio, 4),
            "closure_gap_m": round(closure_gap_m, 1),
            "within_requested_distance": within_distance,
            "segment_ids": [segment.segment_id for segment in candidate.segments],
            "directions": [str(segment.properties.get("route_direction") or "forward") for segment in candidate.segments],
            "provider": "amap",
            "mode": "bicycling",
        },
        "geometry": {"type": "LineString", "coordinates": coordinates},
    }
