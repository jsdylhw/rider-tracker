"""Evidence-first discovery for landmark cycling loops.

An instruction such as ``环淀山湖`` is not satisfied by joining a few scenic
POIs.  This module keeps discovery evidence separate from route construction:
it tiles Strava Segment Explorer requests, preserves where each Segment was
found, and checks whether detailed Segment geometry covers all sides of a
requested target envelope.  A caller may only call a result a ``loop`` after
the evidence and the subsequent connector validation both pass.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from demo.osm_cycling_router.segment_loop import haversine_m
from demo.osm_cycling_router.strava_segments import explore_segments


@dataclass(frozen=True)
class Bounds:
    """A WGS-84 target envelope in south, west, north, east order."""

    south: float
    west: float
    north: float
    east: float

    def __post_init__(self) -> None:
        if not (-90 <= self.south < self.north <= 90 and -180 <= self.west < self.east <= 180):
            raise ValueError("bounds must be south,west,north,east")

    def as_strava_bounds(self) -> str:
        return f"{self.south:.6f},{self.west:.6f},{self.north:.6f},{self.east:.6f}"

    def tiles(self, *, rows: int = 2, columns: int = 2) -> tuple["Bounds", ...]:
        if rows < 1 or columns < 1:
            raise ValueError("rows and columns must be positive")
        lat_step = (self.north - self.south) / rows
        lon_step = (self.east - self.west) / columns
        return tuple(
            Bounds(
                self.south + row * lat_step,
                self.west + column * lon_step,
                self.south + (row + 1) * lat_step,
                self.west + (column + 1) * lon_step,
            )
            for row in range(rows)
            for column in range(columns)
        )


Explorer = Callable[[str, str], dict[str, Any]]


def discover_segment_evidence(
    target: Bounds,
    access_token: str,
    *,
    rows: int = 2,
    columns: int = 2,
    explorer: Explorer | None = None,
) -> dict[str, Any]:
    """Explore a target with a bounded tile grid and deduplicate Segment ids.

    Segment Explorer returns a popularity-ranked sample, not the complete road
    graph.  Keeping every discovery tile makes that limit visible to an Agent
    and lets later refinements request only uncovered areas.
    """
    fetch = explorer or (lambda bounds, token: explore_segments(bounds, token))
    tiles = target.tiles(rows=rows, columns=columns)
    discovered: dict[int, dict[str, Any]] = {}
    tile_summaries: list[dict[str, Any]] = []
    for index, tile in enumerate(tiles):
        sample = fetch(tile.as_strava_bounds(), access_token)
        tile_summaries.append({
            "tile_index": index,
            "bounds_wgs84": [tile.south, tile.west, tile.north, tile.east],
            "segment_count": int(sample.get("segment_count") or len(sample.get("segments") or [])),
        })
        for item in sample.get("segments") or []:
            try:
                segment_id = int(item["id"])
            except (KeyError, TypeError, ValueError):
                continue
            previous = discovered.get(segment_id)
            if previous is None:
                discovered[segment_id] = {**item, "discovered_in_tiles": [index]}
            elif index not in previous["discovered_in_tiles"]:
                # Explorer can repeat the same id in one response.  Tile
                # membership is evidence provenance, not an occurrence count.
                previous["discovered_in_tiles"].append(index)
    segments = sorted(discovered.values(), key=lambda item: (-float(item.get("distance") or 0), int(item["id"])))
    return {
        "schema_version": "route_segment_discovery.v1",
        "target_bounds_wgs84": [target.south, target.west, target.north, target.east],
        "grid": {"rows": rows, "columns": columns},
        "tiles": tile_summaries,
        "unique_segment_count": len(segments),
        "segments": segments,
        "discovery_limit": "Each tile is a popularity-ranked Strava Explorer sample, not complete lake-boundary evidence.",
    }


def assess_loop_evidence(
    features: Sequence[dict[str, Any]],
    target: Bounds,
    *,
    edge_fraction: float = 0.18,
    join_gap_m: float = 2_000,
) -> dict[str, Any]:
    """Assess whether detailed Segment geometries plausibly cover a loop target.

    This is deliberately a conservative proxy, not proof of a rideable loop:
    boundary sides must be represented and Segment endpoints must form a small
    number of components before expensive provider-specific connectors are
    attempted.
    """
    if not 0 < edge_fraction < 0.5:
        raise ValueError("edge_fraction must be between 0 and 0.5")
    normalized = [_feature_geometry(feature) for feature in features]
    side_hits: dict[str, set[int]] = {side: set() for side in ("north", "south", "east", "west")}
    lat_margin = (target.north - target.south) * edge_fraction
    lon_margin = (target.east - target.west) * edge_fraction
    for index, geometry in enumerate(normalized):
        for lon, lat in geometry:
            # A segment far outside the target can otherwise satisfy a side
            # merely because it is north/south of it.  A boundary hit must
            # also project onto that side of the requested envelope.
            if target.north - lat_margin <= lat <= target.north + lat_margin and target.west - lon_margin <= lon <= target.east + lon_margin:
                side_hits["north"].add(index)
            if target.south - lat_margin <= lat <= target.south + lat_margin and target.west - lon_margin <= lon <= target.east + lon_margin:
                side_hits["south"].add(index)
            if target.east - lon_margin <= lon <= target.east + lon_margin and target.south - lat_margin <= lat <= target.north + lat_margin:
                side_hits["east"].add(index)
            if target.west - lon_margin <= lon <= target.west + lon_margin and target.south - lat_margin <= lat <= target.north + lat_margin:
                side_hits["west"].add(index)
    components = _endpoint_components(normalized, join_gap_m=join_gap_m)
    missing_sides = [side for side, hit in side_hits.items() if not hit]
    if missing_sides:
        status = "insufficient_perimeter_evidence"
    elif len(components) > 1:
        status = "requires_connector_validation"
    else:
        status = "skeleton_candidate"
    return {
        "schema_version": "route_loop_evidence.v1",
        "status": status,
        "segment_count": len(normalized),
        "target_bounds_wgs84": [target.south, target.west, target.north, target.east],
        "edge_fraction": edge_fraction,
        "join_gap_m": join_gap_m,
        "side_coverage": {side: sorted(indices) for side, indices in side_hits.items()},
        "missing_sides": missing_sides,
        "component_count": len(components),
        "components": [sorted(component) for component in components],
        "next_action": _next_action(status, missing_sides),
    }


def validate_route_candidate(
    *,
    distance_m: float,
    closure_gap_m: float,
    retrace_ratio: float,
    min_distance_m: float,
    max_distance_m: float,
    loop_evidence: dict[str, Any],
    max_closure_gap_m: float = 100.0,
    max_retrace_ratio: float = 0.22,
) -> dict[str, Any]:
    """Apply the final, explainable acceptance gate to a generated candidate."""
    checks = {
        "distance_in_range": min_distance_m <= distance_m <= max_distance_m,
        "closure": closure_gap_m <= max_closure_gap_m,
        "retrace": retrace_ratio <= max_retrace_ratio,
        "skeleton_evidence": loop_evidence.get("status") == "skeleton_candidate",
    }
    return {
        "schema_version": "route_candidate_validation.v1",
        "accepted": all(checks.values()),
        "checks": checks,
        "distance_m": round(distance_m, 1),
        "distance_range_m": [round(min_distance_m, 1), round(max_distance_m, 1)],
        "closure_gap_m": round(closure_gap_m, 1),
        "retrace_ratio": round(retrace_ratio, 4),
        "rejection_reasons": [name for name, passed in checks.items() if not passed],
    }


def _feature_geometry(feature: dict[str, Any]) -> tuple[tuple[float, float], ...]:
    geometry = feature.get("geometry") or {}
    if geometry.get("type") != "LineString":
        raise ValueError("loop evidence requires LineString Segment features")
    points = tuple((float(point[0]), float(point[1])) for point in geometry.get("coordinates") or [] if len(point) >= 2)
    if len(points) < 2:
        raise ValueError("loop evidence requires at least two points per Segment")
    return points


def _endpoint_components(geometries: Sequence[Sequence[tuple[float, float]]], *, join_gap_m: float) -> list[set[int]]:
    parents = list(range(len(geometries)))

    def find(value: int) -> int:
        while parents[value] != value:
            parents[value] = parents[parents[value]]
            value = parents[value]
        return value

    def union(first: int, second: int) -> None:
        first_root, second_root = find(first), find(second)
        if first_root != second_root:
            parents[second_root] = first_root

    for first, first_geometry in enumerate(geometries):
        for second, second_geometry in enumerate(geometries[first + 1:], start=first + 1):
            endpoints = (first_geometry[0], first_geometry[-1])
            other_endpoints = (second_geometry[0], second_geometry[-1])
            if min(haversine_m(endpoint, other) for endpoint in endpoints for other in other_endpoints) <= join_gap_m:
                union(first, second)
    grouped: dict[int, set[int]] = {}
    for index in range(len(geometries)):
        grouped.setdefault(find(index), set()).add(index)
    return list(grouped.values())


def _next_action(status: str, missing_sides: Iterable[str]) -> str:
    if status == "insufficient_perimeter_evidence":
        return f"Request more detailed Strava evidence for uncovered target sides: {', '.join(missing_sides)}."
    if status == "requires_connector_validation":
        return "Use the selected routing provider to validate the short connectors between evidence components."
    return "Generate provider-specific connector candidates, then apply final distance/closure/retrace validation."
