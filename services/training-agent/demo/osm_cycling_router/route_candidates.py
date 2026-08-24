"""Generate and globally combine multiple connector choices for climb loops.

The planner treats a named road corridor as a *partial* via constraint.  It
never assumes that a rider must traverse the entire road: each corridor offers
several anchors, alongside the normal direct connection.
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from itertools import permutations, product
from pathlib import Path
from typing import Any

try:
    from .road_corridors import RoadCorridor, haversine_m, search_road_corridors
    from .router import Point, route_points
    from .segment_loop import DirectedSegment, reverse_segment, segment_from_feature
except ImportError:  # pragma: no cover - direct Docker invocation
    from road_corridors import RoadCorridor, haversine_m, search_road_corridors
    from router import Point, route_points
    from segment_loop import DirectedSegment, reverse_segment, segment_from_feature


MAX_SEGMENTS = 5
ConnectorFetcher = Callable[[Sequence[Point]], dict[str, Any]]
ConnectorBuilder = Callable[[Point, Point], Sequence["ConnectorCandidate"]]


def _cells(coordinates: Sequence[tuple[float, float]]) -> frozenset[tuple[int, int]]:
    return frozenset((round(lat * 1_000), round(lon * 1_000)) for lon, lat in coordinates)


def _result_geometry(result: dict[str, Any]) -> tuple[tuple[float, float], ...]:
    coordinates = (result.get("raw") or {}).get("paths", [{}])[0].get("points", {}).get("coordinates", [])
    if len(coordinates) < 2:
        raise ValueError("connector result contains insufficient geometry")
    return tuple((float(lon), float(lat)) for lon, lat in coordinates)


def _result_way_ids(result: dict[str, Any]) -> frozenset[int]:
    values = ((result.get("details") or {}).get("osm_way_id") or [])
    ids: set[int] = set()
    for item in values:
        if len(item) >= 3:
            try:
                ids.add(int(item[2]))
            except (TypeError, ValueError):
                pass
    return frozenset(ids)


@dataclass(frozen=True)
class ConnectorCandidate:
    origin: Point
    destination: Point
    geometry: tuple[tuple[float, float], ...]
    distance_m: float
    corridor_name: str | None = None
    corridor_ref: str | None = None
    corridor_coverage_way_ids: frozenset[int] = frozenset()

    @property
    def is_direct(self) -> bool:
        return self.corridor_name is None and self.corridor_ref is None


@dataclass(frozen=True)
class CandidateRoute:
    segments: tuple[DirectedSegment, ...]
    connectors: tuple[ConnectorCandidate, ...]
    total_distance_m: float
    connector_distance_m: float
    overlap_ratio: float
    corridor_count: int
    score: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "total_distance_m": round(self.total_distance_m, 1),
            "connector_distance_m": round(self.connector_distance_m, 1),
            "overlap_ratio": round(self.overlap_ratio, 4),
            "corridor_count": self.corridor_count,
            "score": round(self.score, 2),
            "segments": [{"id": item.segment_id, "name": item.name, "direction": item.properties.get("route_direction", "forward")} for item in self.segments],
            "connectors": [{
                "distance_m": round(item.distance_m, 1), "corridor_name": item.corridor_name,
                "corridor_ref": item.corridor_ref,
            } for item in self.connectors],
        }


def _anchor_rank(origin: Point, destination: Point, anchor: tuple[float, float]) -> float:
    point = Point(*anchor)
    return haversine_m((origin.lat, origin.lon), (point.lat, point.lon)) + haversine_m((point.lat, point.lon), (destination.lat, destination.lon))


def connector_candidates(
    origin: Point,
    destination: Point,
    *,
    corridors: Sequence[RoadCorridor] = (),
    profile: str = "car",
    max_candidates: int = 5,
    max_anchors_per_corridor: int = 3,
    max_detour_ratio: float = 1.6,
    fetcher: ConnectorFetcher = route_points,
) -> list[ConnectorCandidate]:
    """Return direct plus bounded, partial-corridor connector alternatives."""
    if max_candidates < 1:
        raise ValueError("max_candidates must be positive")
    direct_result = fetcher((origin, destination), profile=profile)
    direct = ConnectorCandidate(origin, destination, _result_geometry(direct_result), float(direct_result["distance_m"]))
    results = [direct]
    seen = {_cells(direct.geometry)}
    for corridor in corridors:
        anchors = sorted(corridor.anchors, key=lambda item: _anchor_rank(origin, destination, item))[:max_anchors_per_corridor]
        for anchor in anchors:
            result = fetcher((origin, Point(*anchor), destination), profile=profile)
            geometry = _result_geometry(result)
            distance_m = float(result["distance_m"])
            if distance_m > direct.distance_m * max_detour_ratio:
                continue
            corridor_ids = frozenset(corridor.osm_way_ids) & _result_way_ids(result)
            if not corridor_ids:
                continue
            geometry_cells = _cells(geometry)
            if any(len(geometry_cells & previous) / max(1, len(geometry_cells | previous)) >= 0.96 for previous in seen):
                continue
            seen.add(geometry_cells)
            results.append(ConnectorCandidate(
                origin, destination, geometry, distance_m,
                corridor_name=corridor.name, corridor_ref=corridor.ref,
                corridor_coverage_way_ids=corridor_ids,
            ))
    return sorted(results, key=lambda item: (item.distance_m, item.corridor_ref or "", item.corridor_name or ""))[:max_candidates]


def _route_score(
    *, total_distance_m: float, target_distance_m: float, connector_distance_m: float,
    route_cells: frozenset[tuple[int, int]], overlap_cells: int, corridor_count: int,
) -> float:
    distance_error = abs(total_distance_m - target_distance_m) / max(1.0, target_distance_m)
    overlap_ratio = overlap_cells / max(1, len(route_cells))
    return distance_error * 100 + connector_distance_m / 1_000 * 0.3 + overlap_ratio * 100 - corridor_count * 2.0


def plan_candidate_loops(
    segments: Sequence[DirectedSegment],
    *,
    start: Point,
    target_distance_m: float,
    connector_builder: ConnectorBuilder,
    allow_reverse: bool = True,
    max_routes: int = 3,
    beam_width: int = 16,
) -> list[CandidateRoute]:
    """Search segment order, direction and connector choices together.

    The beam keeps the search bounded while still evaluating connector overlap
    against all previously selected main segments and connectors.
    """
    if not 1 <= len(segments) <= MAX_SEGMENTS:
        raise ValueError(f"segment count must be between 1 and {MAX_SEGMENTS}")
    if target_distance_m <= 0 or max_routes < 1 or beam_width < 1:
        raise ValueError("target distance, max routes and beam width must be positive")
    options = [(segment, reverse_segment(segment)) if allow_reverse else (segment,) for segment in segments]
    complete: list[CandidateRoute] = []
    connector_cache: dict[tuple[float, float, float, float], tuple[ConnectorCandidate, ...]] = {}

    def links(origin: Point, destination: Point) -> tuple[ConnectorCandidate, ...]:
        key = (origin.lat, origin.lon, destination.lat, destination.lon)
        if key not in connector_cache:
            connector_cache[key] = tuple(connector_builder(origin, destination))
        return connector_cache[key]

    for directions in product(*options):
        for order in permutations(range(len(directions))):
            ordered = tuple(directions[index] for index in order)
            link_options = [links(start, ordered[0].start)]
            link_options.extend(links(first.end, second.start) for first, second in zip(ordered, ordered[1:]))
            link_options.append(links(ordered[-1].end, start))
            if any(not choices for choices in link_options):
                continue
            main_cells = _cells(tuple(point for segment in ordered for point in segment.geometry))
            states: list[tuple[tuple[ConnectorCandidate, ...], frozenset[tuple[int, int]], int, float, set[str]]] = [
                ((), main_cells, 0, 0.0, set()),
            ]
            for choices in link_options:
                next_states = []
                for selected, cells, overlap, connector_distance, corridors in states:
                    for choice in choices:
                        choice_cells = _cells(choice.geometry)
                        next_corridors = set(corridors)
                        if choice.corridor_ref or choice.corridor_name:
                            next_corridors.add(choice.corridor_ref or choice.corridor_name or "")
                        next_states.append((
                            selected + (choice,), cells | choice_cells, overlap + len(cells & choice_cells),
                            connector_distance + choice.distance_m, next_corridors,
                        ))
                states = sorted(next_states, key=lambda item: (item[3] / 1_000 * 0.3 + item[2] * 0.2 - len(item[4]) * 2))[:beam_width]
            segment_distance = sum(item.distance_m for item in ordered)
            for selected, cells, overlap, connector_distance, corridors in states:
                total = segment_distance + connector_distance
                complete.append(CandidateRoute(
                    ordered, selected, total, connector_distance, overlap / max(1, len(cells)), len(corridors),
                    _route_score(total_distance_m=total, target_distance_m=target_distance_m, connector_distance_m=connector_distance,
                                 route_cells=cells, overlap_cells=overlap, corridor_count=len(corridors)),
                ))

    selected: list[CandidateRoute] = []
    seen: set[tuple[tuple[int | None, str], ...]] = set()
    selected_geometries: list[frozenset[tuple[int, int]]] = []

    # A preferred corridor is optional by default. Keep the best all-direct
    # baseline so the user can compare its detour/retrace cost with scenic
    # alternatives instead of receiving several variants of the same idea.
    direct_baseline = next(
        (item for item in sorted(complete, key=lambda item: item.score) if all(connector.is_direct for connector in item.connectors)),
        None,
    )
    if direct_baseline is not None:
        selected.append(direct_baseline)
        selected_geometries.append(_cells(tuple(
            point for segment in direct_baseline.segments for point in segment.geometry
        ) + tuple(point for connector in direct_baseline.connectors for point in connector.geometry)))

    for route in sorted(complete, key=lambda item: item.score):
        if route is direct_baseline:
            continue
        signature = tuple((segment.segment_id, str(segment.properties.get("route_direction", "forward"))) for segment in route.segments)
        connector_signature = tuple((item.corridor_ref or item.corridor_name or "direct") for item in route.connectors)
        key = signature + tuple((None, item) for item in connector_signature)
        if key in seen:
            continue
        route_geometry = _cells(tuple(
            point for segment in route.segments for point in segment.geometry
        ) + tuple(point for connector in route.connectors for point in connector.geometry))
        if any(
            len(route_geometry & prior) / max(1, len(route_geometry | prior)) >= 0.88
            for prior in selected_geometries
        ):
            continue
        seen.add(key)
        selected_geometries.append(route_geometry)
        selected.append(route)
        if len(selected) == max_routes:
            break
    return selected


def _combined_route_geometry(route: CandidateRoute) -> list[list[float]]:
    """Join connectors and source segments in the exact planned travel order."""
    coordinates: list[list[float]] = []
    for index, connector in enumerate(route.connectors):
        for lon, lat in connector.geometry:
            point = [lon, lat]
            if not coordinates or coordinates[-1] != point:
                coordinates.append(point)
        if index < len(route.segments):
            for lon, lat in route.segments[index].geometry:
                point = [lon, lat]
                if coordinates[-1] != point:
                    coordinates.append(point)
    if len(coordinates) < 2:
        raise ValueError("candidate route contains insufficient geometry")
    return coordinates


def candidate_routes_geojson(
    routes: Sequence[CandidateRoute],
    *,
    name: str,
    start: Point,
    target_distance_m: float,
) -> dict[str, Any]:
    """Serialize comparable candidate loops as one browser-ready GeoJSON probe."""
    palette = ("#667785", "#d64f3b", "#2d7dd2", "#9b59b6", "#e0a62b")
    features: list[dict[str, Any]] = []
    for index, route in enumerate(routes, start=1):
        role = "直连基线" if route.corridor_count == 0 else f"经 {route.corridor_count} 条语义走廊"
        features.append({
            "type": "Feature",
            "properties": {
                "kind": "graphhopper_candidate",
                "name": f"候选 {index} · {role}",
                "color": palette[(index - 1) % len(palette)],
                "distance_m": round(route.total_distance_m, 1),
                "connector_distance_m": round(route.connector_distance_m, 1),
                "overlap_ratio": round(route.overlap_ratio, 4),
                "corridor_count": route.corridor_count,
                "segments": route.as_dict()["segments"],
            },
            "geometry": {"type": "LineString", "coordinates": _combined_route_geometry(route)},
        })
    return {
        "type": "FeatureCollection",
        "metadata": {
            "name": name,
            "target_distance_m": round(target_distance_m, 1),
            "total_distance_m": round(routes[0].total_distance_m, 1) if routes else 0,
            "candidate_count": len(routes),
            "start_latlng": [start.lat, start.lon],
            "end_latlng": [start.lat, start.lon],
            "closure_gap_m": 0,
        },
        "features": features,
    }


def _point(value: str) -> Point:
    try:
        lat, lon = (float(item.strip()) for item in value.split(",", 1))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("point must be latitude,longitude") from exc
    return Point(lat, lon)


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan multiple local connector candidates around real climb segments")
    parser.add_argument("--input", type=Path, required=True, help="Strava climb FeatureCollection")
    parser.add_argument("--segment-id", type=int, action="append", help="include only this source segment id, repeatable")
    parser.add_argument("--road-database", type=Path, required=True)
    parser.add_argument("--corridor", action="append", default=[], help="named/ref'ed optional corridor, repeatable")
    parser.add_argument("--start", type=_point, required=True)
    parser.add_argument("--target-km", type=float, required=True)
    parser.add_argument("--profile", choices=("car", "bike", "racingbike"), default="car")
    parser.add_argument("--allow-reverse", action="store_true")
    parser.add_argument("--max-routes", type=int, default=3)
    parser.add_argument("--output", type=Path, help="optional browser-ready GeoJSON output")
    parser.add_argument("--name", default="多候选主爬闭环（实验）")
    args = parser.parse_args()
    source = json.loads(args.input.read_text(encoding="utf-8"))
    selected_ids = set(args.segment_id or ())
    segments = [
        segment_from_feature(feature)
        for feature in source.get("features") or []
        if feature.get("properties", {}).get("kind") == "strava_segment"
        and (not selected_ids or feature.get("properties", {}).get("id") in selected_ids)
    ]
    if not segments:
        parser.error("no requested source segments were found")
    corridors = [item for query in args.corridor for item in search_road_corridors(args.road_database, query)]

    def build(origin: Point, destination: Point) -> list[ConnectorCandidate]:
        return connector_candidates(origin, destination, corridors=corridors, profile=args.profile)

    routes = plan_candidate_loops(
        segments, start=args.start, target_distance_m=args.target_km * 1_000,
        connector_builder=build, allow_reverse=args.allow_reverse, max_routes=args.max_routes,
    )
    output = {
        "schema_version": "route_candidate_plan.v1",
        "start": {"lat": args.start.lat, "lon": args.start.lon},
        "target_distance_m": args.target_km * 1_000,
        "corridors": [item.as_dict() for item in corridors],
        "routes": [item.as_dict() for item in routes],
    }
    if args.output:
        geojson = candidate_routes_geojson(
            routes, name=args.name, start=args.start, target_distance_m=args.target_km * 1_000,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(geojson, ensure_ascii=False), encoding="utf-8")
        output["geojson_output"] = str(args.output)
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
