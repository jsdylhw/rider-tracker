"""Bounded, evidence-first discovery for landmark cycling loops.

This is the reusable first half of a landmark route workflow.  It deliberately
stops before navigation when the public segment evidence is incomplete:

``intent -> tiled discovery -> selected detail fetches -> loop evidence ->
provider connector validation -> candidate ranking``.

The final two stages must use a routing provider (AMap for the China demo) and
must retain their own geometry/closure/retrace checks.  Keeping discovery in a
separate persisted result means an LLM cannot turn a few suggested POIs into a
claim that a real "环湖" route exists.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from itertools import permutations, product
import time
from typing import Any

from demo.osm_cycling_router.router import Point
from demo.osm_cycling_router.segment_loop import DirectedSegment, haversine_m, reverse_segment
from demo.osm_cycling_router.strava_segments import (
    explore_segments,
    fetch_segment_detail,
    segment_detail_feature,
)

from .route_evidence import Bounds, assess_loop_evidence, discover_segment_evidence


DetailFetcher = Callable[[int, str], dict[str, Any]]


@dataclass(frozen=True)
class LandmarkRouteRequest:
    """Map-resolved request.  Coordinates stay WGS-84 until an AMap boundary."""

    landmark: str
    target_bounds: Bounds
    min_distance_m: float
    max_distance_m: float
    start_name: str = "指定起点"
    landmark_aliases: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.min_distance_m <= 0 or self.max_distance_m < self.min_distance_m:
            raise ValueError("route distance range must be positive and ordered")

    def as_dict(self) -> dict[str, Any]:
        return {
            "landmark": self.landmark,
            "target_bounds_wgs84": [
                self.target_bounds.south, self.target_bounds.west,
                self.target_bounds.north, self.target_bounds.east,
            ],
            "distance_range_m": [self.min_distance_m, self.max_distance_m],
            "start_name": self.start_name,
            "landmark_aliases": list(self.landmark_aliases),
        }


@dataclass(frozen=True)
class SkeletonOrder:
    """A no-network ordering candidate that must still be provider-validated."""

    segments: tuple[DirectedSegment, ...]
    approximate_distance_m: float
    approximate_connector_m: float
    max_approximate_connector_m: float
    score: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "segment_ids": [segment.segment_id for segment in self.segments],
            "directions": [str(segment.properties.get("route_direction") or "forward") for segment in self.segments],
            "approximate_distance_m": round(self.approximate_distance_m, 1),
            "approximate_connector_m": round(self.approximate_connector_m, 1),
            "max_approximate_connector_m": round(self.max_approximate_connector_m, 1),
            "score": round(self.score, 2),
        }


def rank_skeleton_orders(
    segments: Sequence[DirectedSegment],
    *,
    start: Point,
    target_distance_m: float,
    allow_reverse: bool = True,
    max_candidates: int = 3,
) -> list[SkeletonOrder]:
    """Rank a few route-book orders before spending map-provider requests.

    This uses only great-circle endpoint gaps, so it **never** represents a
    route result.  Its job is to reduce a five-segment 384-order search to a
    small, deterministic set for AMap bicycle validation.  Directional
    variants are important: a popular climb may legitimately be the descent
    side of a landmark loop.
    """
    if not 1 <= len(segments) <= 5:
        raise ValueError("rank_skeleton_orders accepts one to five segments")
    if target_distance_m <= 0 or max_candidates < 1:
        raise ValueError("target_distance_m and max_candidates must be positive")
    variants = [(segment, reverse_segment(segment)) if allow_reverse else (segment,) for segment in segments]
    ranked: list[SkeletonOrder] = []
    for directions in product(*variants):
        for order in permutations(range(len(directions))):
            ordered = tuple(directions[index] for index in order)
            endpoints = ((start.lon, start.lat),) + tuple(point for segment in ordered for point in (segment.geometry[0], segment.geometry[-1]))
            gaps = [
                haversine_m(endpoints[index], endpoints[index + 1])
                for index in range(0, len(endpoints) - 1, 2)
            ]
            # The final return to the start is part of the route-book.
            gaps.append(haversine_m((ordered[-1].end.lon, ordered[-1].end.lat), (start.lon, start.lat)))
            connector_m = sum(gaps)
            approximate_distance_m = sum(segment.distance_m for segment in ordered) + connector_m
            distance_error = abs(approximate_distance_m - target_distance_m) / target_distance_m
            score = distance_error * 100 + max(gaps) / 1_000 * 3 + connector_m / 1_000 * .3
            ranked.append(SkeletonOrder(ordered, approximate_distance_m, connector_m, max(gaps), score))
    # A deterministic order/direction signature avoids returning duplicate
    # rotations.  Start is fixed, so rotations are intentionally distinct only
    # if they change the route order after that start.
    unique: dict[tuple[tuple[int | None, str], ...], SkeletonOrder] = {}
    for candidate in sorted(ranked, key=lambda item: item.score):
        key = tuple((segment.segment_id, str(segment.properties.get("route_direction") or "forward")) for segment in candidate.segments)
        unique.setdefault(key, candidate)
    return list(unique.values())[:max_candidates]


def run_landmark_evidence_workflow(
    request: LandmarkRouteRequest,
    access_token: str,
    *,
    rows: int = 2,
    columns: int = 2,
    max_detail_segments: int = 8,
    request_budget_s: float = 45.0,
    explorer: Callable[[str, str], dict[str, Any]] | None = None,
    detail_fetcher: DetailFetcher | None = None,
    cached_features: Sequence[dict[str, Any]] = (),
) -> dict[str, Any]:
    """Fetch a small auditable Segment sample and decide whether routing may start.

    The cap applies to Segment *detail* requests; Explorer requests are exactly
    the requested tile grid.  Cached detail geometry is reused by Segment id,
    and the wall-clock budget turns a poor network path into an explicit,
    retryable partial result rather than a stalled planning run.  The returned document is safe to persist and
    expose to an Agent/UI: it stores ids, route evidence and failure reasons,
    never the bearer token or a raw API response containing unrelated fields.
    """
    if max_detail_segments < 1:
        raise ValueError("max_detail_segments must be positive")
    if request_budget_s <= 0:
        raise ValueError("request_budget_s must be positive")
    started_at = time.monotonic()
    bounded_explorer = explorer or (
        lambda bounds, token: explore_segments(bounds, token, timeout_s=8.0, retry_attempts=0)
    )
    discovery = discover_segment_evidence(
        request.target_bounds, access_token, rows=rows, columns=columns, explorer=bounded_explorer,
    )
    selected = select_detail_candidates(
        discovery["segments"], request.target_bounds, maximum=max_detail_segments,
        semantic_terms=(request.landmark, *request.landmark_aliases),
    )
    fetch = detail_fetcher or (
        lambda segment_id, token: fetch_segment_detail(segment_id, token, timeout_s=8.0, retry_attempts=0)
    )
    cached_by_id = {
        int(feature.get("properties", {}).get("id")): feature
        for feature in cached_features
        if isinstance(feature.get("properties", {}).get("id"), (int, str))
        and str(feature.get("properties", {}).get("id")).isdigit()
    }
    features: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    cache_hits: list[int] = []
    for item in selected:
        segment_id = int(item["id"])
        if segment_id in cached_by_id:
            features.append(cached_by_id[segment_id])
            cache_hits.append(segment_id)
            continue
        if time.monotonic() - started_at >= request_budget_s:
            failures.append({"segment_id": segment_id, "error": "request_budget_exhausted", "message": "retry this remaining detail request in a later run"})
            continue
        try:
            features.append(segment_detail_feature(fetch(segment_id, access_token)))
        except Exception as exc:  # noqa: BLE001 - retain the rest of the bounded sample
            failures.append({"segment_id": segment_id, "error": type(exc).__name__, "message": str(exc)})

    evidence = assess_loop_evidence(features, request.target_bounds) if features else {
        "schema_version": "route_loop_evidence.v1",
        "status": "insufficient_perimeter_evidence",
        "segment_count": 0,
        "missing_sides": ["north", "south", "east", "west"],
        "component_count": 0,
        "next_action": "Fetch usable Segment details before attempting a landmark loop.",
    }
    evidence_status = str(evidence["status"])
    status = {
        "insufficient_perimeter_evidence": "needs_more_evidence",
        "requires_connector_validation": "needs_connector_validation",
        "skeleton_candidate": "ready_for_connector_routing",
    }[evidence_status]
    return {
        "schema_version": "landmark_route_evidence_run.v1",
        "status": status,
        "request": request.as_dict(),
        "discovery": discovery,
        "selected_segment_ids": [int(item["id"]) for item in selected],
        "cached_detail_segment_ids": cache_hits,
        "detail_feature_collection": {
            "type": "FeatureCollection",
            "metadata": {
                "schema_version": "strava_segment_details_geojson.v1",
                "source": "strava_segment_detail",
                "segment_ids": [int(feature["properties"]["id"]) for feature in features],
            },
            "features": features,
        },
        "detail_failures": failures,
        "loop_evidence": evidence,
        "next_action": _workflow_next_action(status),
    }


def select_detail_candidates(
    segments: Sequence[dict[str, Any]], target: Bounds, *, maximum: int,
    semantic_terms: Sequence[str] = (),
) -> list[dict[str, Any]]:
    """Choose a small geographically diverse detail sample from Explorer data.

    Explorer only gives a popularity-ranked list.  Select records that touch
    target sides first (using their published endpoints), then fill the budget
    by landmark-name affinity and distance.  This makes the selection
    repeatable and avoids fetching ten near-identical segments from one
    popular road.  Name affinity is only a selection hint: it never counts as
    geometry evidence.
    """
    if maximum < 1:
        raise ValueError("maximum must be positive")
    normalized_terms = tuple(term.casefold().strip() for term in semantic_terms if term and term.strip())
    prepared: list[tuple[dict[str, Any], frozenset[str], int, float]] = []
    for raw in segments:
        try:
            segment_id = int(raw["id"])
        except (KeyError, TypeError, ValueError):
            continue
        item = dict(raw)
        item["id"] = segment_id
        name = str(item.get("name") or "").casefold()
        affinity = sum(term in name for term in normalized_terms)
        prepared.append((item, _endpoint_sides(item, target), affinity, float(item.get("distance") or 0)))

    selected: list[dict[str, Any]] = []
    covered: set[str] = set()
    remaining = prepared[:]
    while remaining and len(selected) < maximum:
        # If the caller resolved a named landmark, inspect its directly named
        # segments before generic nearby roads.  This is a discovery-budget
        # choice only; the later geometry check remains the source of truth.
        semantic_remaining = [index for index, item in enumerate(remaining) if item[2] > 0]
        candidates = semantic_remaining or list(range(len(remaining)))
        # Then favour new sides, total side coverage and longer roads; id gives
        # a stable tie-breaker across equal Explorer responses.
        best_index = max(
            candidates,
            key=lambda index: (
                len(remaining[index][1] - covered), len(remaining[index][1]),
                remaining[index][2], remaining[index][3], -int(remaining[index][0]["id"]),
            ),
        )
        item, sides, _, _ = remaining.pop(best_index)
        selected.append(item)
        covered.update(sides)
    return selected


def _endpoint_sides(segment: dict[str, Any], target: Bounds, *, edge_fraction: float = .18) -> frozenset[str]:
    points = []
    for key in ("start_latlng", "end_latlng"):
        value = segment.get(key)
        if isinstance(value, Sequence) and len(value) >= 2:
            try:
                points.append((float(value[1]), float(value[0])))  # lon, lat
            except (TypeError, ValueError):
                pass
    sides: set[str] = set()
    lat_margin = (target.north - target.south) * edge_fraction
    lon_margin = (target.east - target.west) * edge_fraction
    for lon, lat in points:
        if target.north - lat_margin <= lat <= target.north + lat_margin and target.west - lon_margin <= lon <= target.east + lon_margin:
            sides.add("north")
        if target.south - lat_margin <= lat <= target.south + lat_margin and target.west - lon_margin <= lon <= target.east + lon_margin:
            sides.add("south")
        if target.east - lon_margin <= lon <= target.east + lon_margin and target.south - lat_margin <= lat <= target.north + lat_margin:
            sides.add("east")
        if target.west - lon_margin <= lon <= target.west + lon_margin and target.south - lat_margin <= lat <= target.north + lat_margin:
            sides.add("west")
    return frozenset(sides)


def _workflow_next_action(status: str) -> str:
    if status == "needs_more_evidence":
        return "Expand only the uncovered landmark-side tiles, then repeat evidence assessment; do not generate a route labelled as a landmark loop."
    if status == "needs_connector_validation":
        return "Ask the selected map provider for bicycle connectors between evidence components; reject candidates outside distance, closure or retrace limits."
    return "Construct several provider-routed connector candidates, then rank only candidates that pass distance, closure and retrace validation."
