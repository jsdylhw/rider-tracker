"""Plan closed cycling loops from directed, real-world climb segments.

Each source segment is a directed task: its start-to-end direction is retained
so an uphill segment is not silently reversed.  The planner evaluates every
order for a small candidate set, using local GraphHopper only for connectors.
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from itertools import permutations
from itertools import product
from pathlib import Path
from typing import Any

try:
    from .router import Point, route
except ImportError:  # pragma: no cover - direct Docker invocation
    from router import Point, route


MAX_SEGMENTS = 7
MAX_REVERSIBLE_SEGMENTS = 5
EARTH_RADIUS_M = 6_371_000.0
ConnectorFetcher = Callable[[Point, Point], dict[str, Any]]


def haversine_m(first: Sequence[float], second: Sequence[float]) -> float:
    lon1, lat1 = map(math.radians, (float(first[0]), float(first[1])))
    lon2, lat2 = map(math.radians, (float(second[0]), float(second[1])))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.asin(math.sqrt(value))


def _near_handoff_connector(source: DirectedSegment, target: DirectedSegment, *, profile: str) -> Connector:
    """Represent a short gap between two independently observed Strava segments.

    It is deliberately not a GraphHopper route.  The resulting GeoJSON marks
    it as a yellow dashed seam so the rider can verify the last few metres on
    the map or on site.
    """
    distance_m = haversine_m(source.geometry[-1], target.geometry[0])
    return Connector(
        source=source,
        target=target,
        distance_m=distance_m,
        ascend_m=0.0,
        geometry=(source.geometry[-1], target.geometry[0]),
        details={"profile": profile, "kind": "strava_handoff_gap", "handoff_gap_m": round(distance_m, 1)},
    )


def _rotate_closed_segment_near(segment: DirectedSegment, point: Point, *, maximum_gap_m: float) -> DirectedSegment:
    """Move a closed Segment's logical start to the point nearest an access Segment."""
    if maximum_gap_m <= 0 or haversine_m(segment.geometry[0], segment.geometry[-1]) > maximum_gap_m * 2:
        return segment
    nearest_index, nearest_gap = min(
        ((index, haversine_m((point.lon, point.lat), coordinate)) for index, coordinate in enumerate(segment.geometry)),
        key=lambda item: item[1],
    )
    if nearest_gap > maximum_gap_m:
        return segment
    rotated = segment.geometry[nearest_index:] + segment.geometry[:nearest_index + 1]
    return DirectedSegment(
        segment_id=segment.segment_id,
        name=segment.name,
        geometry=rotated,
        distance_m=segment.distance_m,
        ascend_m=segment.ascend_m,
        properties={**segment.properties, "route_start_rotated": True, "observed_handoff_gap_m": round(nearest_gap, 1)},
    )


@dataclass(frozen=True)
class DirectedSegment:
    segment_id: int | None
    name: str
    geometry: tuple[tuple[float, float], ...]
    distance_m: float
    ascend_m: float
    properties: dict[str, Any]

    @property
    def start(self) -> Point:
        lon, lat = self.geometry[0]
        return Point(lat, lon)

    @property
    def end(self) -> Point:
        lon, lat = self.geometry[-1]
        return Point(lat, lon)


@dataclass(frozen=True)
class Connector:
    source: DirectedSegment
    target: DirectedSegment
    distance_m: float
    ascend_m: float
    geometry: tuple[tuple[float, float], ...]
    details: dict[str, Any]


@dataclass(frozen=True)
class LoopCandidate:
    segments: tuple[DirectedSegment, ...]
    entry_connector: Connector | None
    connectors: tuple[Connector, ...]
    total_distance_m: float
    max_connector_m: float
    connector_distance_m: float
    retrace_ratio: float
    score: float


def segment_from_feature(feature: dict[str, Any]) -> DirectedSegment:
    properties = dict(feature.get("properties") or {})
    geometry = feature.get("geometry") or {}
    coordinates = tuple((float(point[0]), float(point[1])) for point in geometry.get("coordinates") or [] if len(point) >= 2)
    if geometry.get("type") != "LineString" or len(coordinates) < 2:
        raise ValueError("directed segment needs a LineString with at least two coordinates")
    return DirectedSegment(
        segment_id=int(properties["id"]) if properties.get("id") is not None else None,
        name=str(properties.get("name") or "unnamed segment"),
        geometry=coordinates,
        distance_m=float(properties.get("distance_m") or 0),
        ascend_m=float(properties.get("ascend_m") or 0),
        properties=properties,
    )


def reverse_segment(segment: DirectedSegment) -> DirectedSegment:
    """Return the same road segment in the opposite travel direction.

    A Strava climb's recorded direction remains valuable training metadata, but
    it must not force a scenic/loop planner to climb every road in that same
    direction.  The reverse variant is a descent/connection candidate, so its
    known ascent is deliberately not counted as a completed climb.
    """
    properties = {
        **segment.properties,
        "route_direction": "reverse",
        "source_segment_id": segment.segment_id,
        "known_descent_m": round(segment.ascend_m, 1),
    }
    return DirectedSegment(
        segment_id=segment.segment_id,
        name=f"{segment.name}（反向）",
        geometry=tuple(reversed(segment.geometry)),
        distance_m=segment.distance_m,
        ascend_m=0.0,
        properties=properties,
    )


def _default_connector(origin: Point, destination: Point, *, profile: str) -> dict[str, Any]:
    return route(origin, destination, profile=profile)


def _connector_from_result(source: DirectedSegment, target: DirectedSegment, result: dict[str, Any]) -> Connector:
    coordinates = tuple((float(point[0]), float(point[1])) for point in result["raw"]["paths"][0]["points"]["coordinates"])
    if len(coordinates) < 2:
        raise RuntimeError("GraphHopper connector contains insufficient geometry")
    return Connector(
        source=source,
        target=target,
        distance_m=float(result["distance_m"]),
        ascend_m=float(result.get("ascend_m") or 0),
        geometry=coordinates,
        details={**dict(result.get("details") or {}), "profile": result.get("profile")},
    )


def _geometry_cells(coordinates: Iterable[tuple[float, float]]) -> frozenset[tuple[int, int]]:
    # About 100 m cells: enough to penalize long out-and-back connectors while
    # ignoring endpoint snapping differences of a few metres.
    return frozenset((round(lat * 1_000), round(lon * 1_000)) for lon, lat in coordinates)


def _candidate_score(
    *, total_distance_m: float, target_distance_m: float, max_connector_m: float, connector_distance_m: float, retrace_ratio: float,
) -> float:
    target_error = abs(total_distance_m - target_distance_m) / max(target_distance_m, 1)
    # The longest transfer is deliberately expensive: it is the primary signal
    # that a mathematically short ring is unpleasant or structurally incoherent.
    return target_error * 100 + max_connector_m / 1_000 * 3 + connector_distance_m / 1_000 * 0.3 + retrace_ratio * 100


def _plan_directed_segment_loop(
    segments: Sequence[DirectedSegment],
    *,
    target_distance_m: float,
    profile: str = "car",
    max_candidates: int = 3,
    connector_fetcher: ConnectorFetcher = _default_connector,
    start: Point | None = None,
    start_name: str = "指定起终点",
) -> list[LoopCandidate]:
    """Evaluate orders for one fixed set of segment directions."""

    cache: dict[tuple[int, int], Connector] = {}
    for source_index, source in enumerate(segments):
        for target_index, target in enumerate(segments):
            if source_index == target_index:
                continue
            cache[source_index, target_index] = _connector_from_result(
                source, target, connector_fetcher(source.end, target.start) if connector_fetcher is not _default_connector else _default_connector(source.end, target.start, profile=profile),
            )

    anchor = (
        DirectedSegment(
            segment_id=None,
            name=start_name,
            geometry=((start.lon, start.lat), (start.lon, start.lat)),
            distance_m=0.0,
            ascend_m=0.0,
            properties={"kind": "route_anchor"},
        )
        if start is not None else None
    )
    all_segment_cells = _geometry_cells(point for segment in segments for point in segment.geometry)
    results: list[LoopCandidate] = []
    for order in permutations(range(len(segments))):
        ordered_segments = tuple(segments[index] for index in order)
        entry_connector = (
            _connector_from_result(
                anchor, ordered_segments[0],
                connector_fetcher(anchor.end, ordered_segments[0].start)
                if connector_fetcher is not _default_connector
                else _default_connector(anchor.end, ordered_segments[0].start, profile=profile),
            )
            if anchor is not None else None
        )
        connectors = tuple(
            cache[order[index], order[index + 1]]
            for index in range(len(order) - 1)
        ) + (
            _connector_from_result(
                ordered_segments[-1], anchor,
                connector_fetcher(ordered_segments[-1].end, anchor.start)
                if connector_fetcher is not _default_connector
                else _default_connector(ordered_segments[-1].end, anchor.start, profile=profile),
            )
            if anchor is not None
            else cache[order[-1], order[0]],
        )
        all_connectors = ((entry_connector,) if entry_connector else ()) + connectors
        connector_distance_m = sum(item.distance_m for item in all_connectors)
        total_distance_m = sum(item.distance_m for item in ordered_segments) + connector_distance_m
        connector_cells = _geometry_cells(point for connector in all_connectors for point in connector.geometry)
        retrace_ratio = len(connector_cells & all_segment_cells) / max(1, len(connector_cells))
        max_connector_m = max(item.distance_m for item in all_connectors)
        results.append(LoopCandidate(
            segments=ordered_segments,
            entry_connector=entry_connector,
            connectors=connectors,
            total_distance_m=total_distance_m,
            max_connector_m=max_connector_m,
            connector_distance_m=connector_distance_m,
            retrace_ratio=retrace_ratio,
            score=_candidate_score(
                total_distance_m=total_distance_m,
                target_distance_m=target_distance_m,
                max_connector_m=max_connector_m,
                connector_distance_m=connector_distance_m,
                retrace_ratio=retrace_ratio,
            ),
        ))

    # Permutations differ only by their starting point.  Keep one canonical
    # rotation per loop, then return the best distinct plans.
    unique: dict[tuple[str, ...], LoopCandidate] = {}
    for candidate in sorted(results, key=lambda item: item.score):
        names = tuple(segment.name for segment in candidate.segments)
        canonical = min(names[index:] + names[:index] for index in range(len(names)))
        unique.setdefault(canonical, candidate)
    return sorted(unique.values(), key=lambda item: item.score)[:max_candidates]


def _candidate_direction_key(candidate: LoopCandidate) -> tuple[tuple[int | None, str], ...]:
    direction_pairs = tuple(
        (segment.segment_id, str(segment.properties.get("route_direction") or "forward"))
        for segment in candidate.segments
    )
    return min(direction_pairs[index:] + direction_pairs[:index] for index in range(len(direction_pairs)))


def plan_segment_loop(
    segments: Sequence[DirectedSegment],
    *,
    target_distance_m: float,
    profile: str = "car",
    max_candidates: int = 3,
    connector_fetcher: ConnectorFetcher = _default_connector,
    allow_reverse: bool = False,
    start: Point | None = None,
    start_name: str = "指定起终点",
) -> list[LoopCandidate]:
    """Plan a loop, optionally choosing a travel direction per source segment.

    Direction selection is intentionally opt-in: a user asking for named
    climbs generally expects their recorded uphill direction.  Scenic loops or
    road-book planning can opt in, letting a segment become a descent instead.
    """
    if not 1 <= len(segments) <= MAX_SEGMENTS:
        raise ValueError(f"segment count must be between 1 and {MAX_SEGMENTS}")
    if target_distance_m <= 0:
        raise ValueError("target_distance_m must be positive")
    if allow_reverse and len(segments) > MAX_REVERSIBLE_SEGMENTS:
        raise ValueError(
            f"reverse-direction search is limited to {MAX_REVERSIBLE_SEGMENTS} segments; "
            "split the route-book into smaller clusters first"
        )
    direction_count = 2 ** len(segments) if allow_reverse else 1
    available = math.factorial(len(segments)) * direction_count
    if not 1 <= max_candidates <= available:
        raise ValueError("max_candidates is outside the available permutation/direction combinations")

    orientation_sets = product((False, True), repeat=len(segments)) if allow_reverse else ((False,) * len(segments),)
    all_candidates: list[LoopCandidate] = []
    for orientations in orientation_sets:
        variants = tuple(reverse_segment(segment) if reverse else segment for segment, reverse in zip(segments, orientations))
        all_candidates.extend(_plan_directed_segment_loop(
            variants,
            target_distance_m=target_distance_m,
            profile=profile,
            max_candidates=math.factorial(len(segments)),
            connector_fetcher=connector_fetcher,
            start=start,
            start_name=start_name,
        ))

    unique: dict[tuple[tuple[int | None, str], ...], LoopCandidate] = {}
    for candidate in sorted(all_candidates, key=lambda item: item.score):
        unique.setdefault(_candidate_direction_key(candidate), candidate)
    return list(unique.values())[:max_candidates]


def plan_ordered_segment_route(
    segments: Sequence[DirectedSegment],
    *,
    start: Point,
    target_distance_m: float,
    profile: str = "racingbike",
    connector_fetcher: ConnectorFetcher = _default_connector,
    start_name: str = "指定起终点",
    near_handoff_m: float = 0.0,
) -> LoopCandidate:
    """Connect already-approved Segment geometry in the supplied travel order.

    This is intentionally different from ``plan_segment_loop``: a bridge or
    ferry Segment may be an access constraint, not another climb to permute.
    The caller supplies the order after inspecting Strava/OSM facts.
    """
    if not 1 <= len(segments) <= MAX_SEGMENTS:
        raise ValueError(f"segment count must be between 1 and {MAX_SEGMENTS}")
    if target_distance_m <= 0:
        raise ValueError("target_distance_m must be positive")
    if near_handoff_m < 0 or near_handoff_m > 500:
        raise ValueError("near_handoff_m must be between 0 and 500")
    anchor = DirectedSegment(
        segment_id=None,
        name=start_name,
        geometry=((start.lon, start.lat), (start.lon, start.lat)),
        distance_m=0.0,
        ascend_m=0.0,
        properties={"kind": "route_anchor"},
    )

    def connect(source: DirectedSegment, target: DirectedSegment) -> Connector:
        result = (
            connector_fetcher(source.end, target.start)
            if connector_fetcher is not _default_connector
            else _default_connector(source.end, target.start, profile=profile)
        )
        return _connector_from_result(source, target, result)

    ordered_segments: list[DirectedSegment] = [segments[0]]
    connectors_list: list[Connector] = []
    for next_segment in segments[1:]:
        previous = ordered_segments[-1]
        adjusted = _rotate_closed_segment_near(next_segment, previous.end, maximum_gap_m=near_handoff_m)
        direct_gap = haversine_m(previous.geometry[-1], adjusted.geometry[0])
        connector = (
            _near_handoff_connector(previous, adjusted, profile=profile)
            if near_handoff_m and direct_gap <= near_handoff_m
            else connect(previous, adjusted)
        )
        connectors_list.append(connector)
        ordered_segments.append(adjusted)
    entry = connect(anchor, ordered_segments[0])
    connectors = tuple(connectors_list) + (connect(ordered_segments[-1], anchor),)
    all_connectors = (entry, *connectors)
    connector_distance_m = sum(item.distance_m for item in all_connectors)
    all_segment_cells = _geometry_cells(point for segment in ordered_segments for point in segment.geometry)
    connector_cells = _geometry_cells(point for connector in all_connectors for point in connector.geometry)
    total_distance_m = sum(item.distance_m for item in ordered_segments) + connector_distance_m
    retrace_ratio = len(connector_cells & all_segment_cells) / max(1, len(connector_cells))
    max_connector_m = max(item.distance_m for item in all_connectors)
    return LoopCandidate(
        segments=tuple(ordered_segments),
        entry_connector=entry,
        connectors=connectors,
        total_distance_m=total_distance_m,
        max_connector_m=max_connector_m,
        connector_distance_m=connector_distance_m,
        retrace_ratio=retrace_ratio,
        score=_candidate_score(
            total_distance_m=total_distance_m,
            target_distance_m=target_distance_m,
            max_connector_m=max_connector_m,
            connector_distance_m=connector_distance_m,
            retrace_ratio=retrace_ratio,
        ),
    )


def candidate_geojson(candidate: LoopCandidate, *, name: str, target_distance_m: float) -> dict[str, Any]:
    features: list[dict[str, Any]] = []
    if candidate.entry_connector:
        connector = candidate.entry_connector
        connector_kind = str(connector.details.get("kind") or (
            "amap_bicycling_connector" if connector.details.get("provider") == "amap" else "graphhopper_connector"
        ))
        features.append({
            "type": "Feature",
            "properties": {
                "kind": connector_kind,
                "name": f"{connector.source.name} → {connector.target.name}",
                "distance_m": round(connector.distance_m, 1),
                "ascend_m": round(connector.ascend_m, 1),
            },
            "geometry": {"type": "LineString", "coordinates": connector.geometry},
        })
    for segment, connector in zip(candidate.segments, candidate.connectors):
        properties = dict(segment.properties)
        properties.update({"kind": "strava_segment", "name": segment.name, "distance_m": round(segment.distance_m, 1), "ascend_m": round(segment.ascend_m, 1)})
        features.append({"type": "Feature", "properties": properties, "geometry": {"type": "LineString", "coordinates": segment.geometry}})
        connector_kind = str(connector.details.get("kind") or (
            "amap_bicycling_connector" if connector.details.get("provider") == "amap" else "graphhopper_connector"
        ))
        features.append({
            "type": "Feature",
            "properties": {
                "kind": connector_kind,
                "name": f"{connector.source.name} → {connector.target.name}",
                "distance_m": round(connector.distance_m, 1),
                "ascend_m": round(connector.ascend_m, 1),
                "handoff_gap_m": connector.details.get("handoff_gap_m"),
            },
            "geometry": {"type": "LineString", "coordinates": connector.geometry},
        })
    start = (
        candidate.entry_connector.source.geometry[0]
        if candidate.entry_connector else candidate.segments[0].geometry[0]
    )
    end = candidate.connectors[-1].geometry[-1]
    return {
        "type": "FeatureCollection",
        "metadata": {
            "name": name,
            "target_distance_m": round(target_distance_m, 1),
            "total_distance_m": round(candidate.total_distance_m, 1),
            "segment_distance_m": round(sum(item.distance_m for item in candidate.segments), 1),
            "connector_distance_m": round(candidate.connector_distance_m, 1),
            "max_connector_m": round(candidate.max_connector_m, 1),
            "known_segment_ascent_m": round(sum(item.ascend_m for item in candidate.segments), 1),
            "connector_profile": (
                candidate.connectors[0].details.get("profile") or "car"
                if candidate.connectors else "car"
            ),
            "retrace_ratio": round(candidate.retrace_ratio, 4),
            "score": round(candidate.score, 2),
            "start_latlng": [start[1], start[0]],
            "end_latlng": [end[1], end[0]],
            "closure_gap_m": round(haversine_m(start, end), 1),
            "segment_ids": [segment.segment_id for segment in candidate.segments],
            "reversed_segment_ids": [
                segment.segment_id for segment in candidate.segments
                if segment.properties.get("route_direction") == "reverse"
            ],
        },
        "features": features,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan a local GraphHopper loop from directed Strava segment GeoJSON")
    parser.add_argument("--input", type=Path, required=True, help="FeatureCollection containing strava_segment features")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-km", type=float, default=80)
    parser.add_argument("--profile", choices=("car", "bike", "racingbike"), default="car", help="profile for main-climb connectors")
    parser.add_argument("--graphhopper-url", default="http://127.0.0.1:8989", help="local GraphHopper base URL")
    parser.add_argument("--allow-reverse", action="store_true", help="allow each source road segment to be used in either direction")
    parser.add_argument("--preserve-input-order", action="store_true", help="treat input Segment order as a fixed route-book constraint")
    parser.add_argument("--near-handoff-m", type=float, default=0, help="accept a short observed Segment-to-Segment seam; render it as a reviewable gap")
    parser.add_argument("--start", help="fixed loop start as latitude,longitude")
    parser.add_argument("--start-name", default="指定起终点")
    parser.add_argument("--name", default="Strava 主爬闭环（实验）")
    args = parser.parse_args()
    source = json.loads(args.input.read_text(encoding="utf-8"))
    segments = [segment_from_feature(feature) for feature in source.get("features") or [] if feature.get("properties", {}).get("kind") == "strava_segment"]
    connector_fetcher = lambda origin, destination: route(
        origin, destination, profile=args.profile, base_url=args.graphhopper_url,
    )
    start = None
    if args.start:
        try:
            latitude, longitude = (float(value.strip()) for value in args.start.split(",", 1))
        except ValueError as error:
            raise SystemExit("--start must be latitude,longitude") from error
        start = Point(latitude, longitude)
    if args.preserve_input_order:
        if start is None:
            parser.error("--preserve-input-order requires --start")
        if args.allow_reverse:
            parser.error("--preserve-input-order cannot be combined with --allow-reverse; provide the intended Segment direction")
        candidate = plan_ordered_segment_route(
            segments, target_distance_m=args.target_km * 1_000,
            profile=args.profile, connector_fetcher=connector_fetcher,
            start=start, start_name=args.start_name, near_handoff_m=args.near_handoff_m,
        )
    else:
        candidate = plan_segment_loop(
            segments, target_distance_m=args.target_km * 1_000,
            profile=args.profile, max_candidates=1, connector_fetcher=connector_fetcher,
            allow_reverse=args.allow_reverse,
            start=start,
            start_name=args.start_name,
        )[0]
    output = candidate_geojson(candidate, name=args.name, target_distance_m=args.target_km * 1_000)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(output["metadata"], ensure_ascii=False))


if __name__ == "__main__":
    main()
