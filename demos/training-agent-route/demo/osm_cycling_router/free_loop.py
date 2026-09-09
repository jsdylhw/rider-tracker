"""Generate and select local GraphHopper free-loop cycling routes.

This module intentionally answers only "ride roughly N km from this start and
return".  It does not claim to circle a named lake or landmark: that requires
landmark area geometry and deterministic via points, which belongs in the next
route-planning capability.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

try:  # package import for tests; direct import for the Docker image
    from .router import Point, round_trip
except ImportError:  # pragma: no cover - exercised by the Docker entrypoint
    from router import Point, round_trip


DEFAULT_SEEDS = tuple(range(8))
DEFAULT_DISTANCE_TOLERANCE = 0.20
MAX_START_END_GAP_M = 100.0
DUPLICATE_JACCARD_THRESHOLD = 0.88
EARTH_RADIUS_M = 6_371_000.0


@dataclass(frozen=True)
class FreeLoopCandidate:
    seed: int
    profile: str
    distance_m: float
    duration_s: float
    ascend_m: float
    distance_error_ratio: float
    start_end_gap_m: float
    score: float
    geometry: dict[str, Any]
    details: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "seed": self.seed,
            "profile": self.profile,
            "distance_m": round(self.distance_m, 1),
            "duration_s": round(self.duration_s, 1),
            "ascend_m": round(self.ascend_m, 1),
            "distance_error_pct": round(self.distance_error_ratio * 100, 1),
            "start_end_gap_m": round(self.start_end_gap_m, 1),
            "score": round(self.score, 1),
            "geometry": self.geometry,
            "details": self.details,
        }


@dataclass(frozen=True)
class FreeLoopPlan:
    origin: Point
    target_distance_m: float
    profile: str
    distance_tolerance: float
    attempts: int
    candidates: tuple[FreeLoopCandidate, ...]
    rejected: tuple[dict[str, Any], ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "free_loop_plan.v1",
            "origin": {"lat": self.origin.lat, "lon": self.origin.lon},
            "target_distance_m": round(self.target_distance_m, 1),
            "profile": self.profile,
            "distance_tolerance_pct": round(self.distance_tolerance * 100, 1),
            "attempts": self.attempts,
            "count": len(self.candidates),
            "candidates": [candidate.as_dict() for candidate in self.candidates],
            "rejected": list(self.rejected),
        }


RoundTripFetcher = Callable[..., dict[str, Any]]


def plan_free_loop(
    origin: Point,
    *,
    target_distance_m: float,
    profile: str = "racingbike",
    seeds: Sequence[int] = DEFAULT_SEEDS,
    max_candidates: int = 3,
    distance_tolerance: float = DEFAULT_DISTANCE_TOLERANCE,
    fetch_round_trip: RoundTripFetcher = round_trip,
    base_url: str = "http://127.0.0.1:8989",
) -> FreeLoopPlan:
    """Generate multiple round-trip candidates, filter and diversify them.

    Each seed is deterministic.  We keep only routes that return to their
    snapped start and fit the requested distance tolerance, then remove
    near-identical geometries before returning the best distance matches.
    """
    if not 1 <= max_candidates <= len(seeds):
        raise ValueError("max_candidates must be between 1 and the number of seeds")
    if not 0 < distance_tolerance <= 0.5:
        raise ValueError("distance_tolerance must be greater than 0 and at most 0.5")

    valid: list[FreeLoopCandidate] = []
    rejected: list[dict[str, Any]] = []
    for seed in seeds:
        try:
            result = fetch_round_trip(
                origin,
                distance_m=target_distance_m,
                seed=seed,
                profile=profile,
                base_url=base_url,
            )
            candidate = _candidate_from_result(result, target_distance_m=target_distance_m, seed=seed)
            if candidate.distance_error_ratio > distance_tolerance:
                rejected.append({"seed": seed, "reason": "distance_out_of_tolerance", "distance_m": round(candidate.distance_m, 1)})
            elif candidate.start_end_gap_m > MAX_START_END_GAP_M:
                rejected.append({"seed": seed, "reason": "does_not_close", "start_end_gap_m": round(candidate.start_end_gap_m, 1)})
            else:
                valid.append(candidate)
        except Exception as exc:  # noqa: BLE001 - one seed must not hide other candidates
            rejected.append({"seed": seed, "reason": "router_error", "message": str(exc)})

    selected: list[FreeLoopCandidate] = []
    for candidate in sorted(valid, key=lambda item: (-item.score, item.seed)):
        if any(_geometry_similarity(candidate.geometry, prior.geometry) >= DUPLICATE_JACCARD_THRESHOLD for prior in selected):
            rejected.append({"seed": candidate.seed, "reason": "near_duplicate"})
            continue
        selected.append(candidate)
        if len(selected) == max_candidates:
            break

    return FreeLoopPlan(
        origin=origin,
        target_distance_m=target_distance_m,
        profile=profile,
        distance_tolerance=distance_tolerance,
        attempts=len(seeds),
        candidates=tuple(selected),
        rejected=tuple(rejected),
    )


def _candidate_from_result(result: dict[str, Any], *, target_distance_m: float, seed: int) -> FreeLoopCandidate:
    raw = result.get("raw") or {}
    paths = raw.get("paths") or []
    if not paths:
        raise ValueError("GraphHopper result contains no path")
    path = paths[0]
    geometry = path.get("points") or {}
    coordinates = geometry.get("coordinates") or []
    if len(coordinates) < 2:
        raise ValueError("GraphHopper result contains insufficient route geometry")
    first, last = coordinates[0], coordinates[-1]
    gap = _haversine_m(float(first[1]), float(first[0]), float(last[1]), float(last[0]))
    distance_m = float(result.get("distance_m") or path.get("distance") or 0.0)
    error_ratio = abs(distance_m - target_distance_m) / target_distance_m
    # The score is intentionally easy to explain: first favour target-distance
    # accuracy, then slightly prefer a truly closed snapped geometry.
    score = max(0.0, 100.0 - error_ratio * 100.0 - min(gap, 100.0) / 25.0)
    return FreeLoopCandidate(
        seed=seed,
        profile=str(result.get("profile") or "racingbike"),
        distance_m=distance_m,
        duration_s=float(result.get("duration_s") or 0.0),
        ascend_m=float(result.get("ascend_m") or 0.0),
        distance_error_ratio=error_ratio,
        start_end_gap_m=gap,
        score=score,
        geometry={"type": "LineString", "coordinates": coordinates},
        details=dict(result.get("details") or path.get("details") or {}),
    )


def _geometry_similarity(first: dict[str, Any], second: dict[str, Any]) -> float:
    first_cells = _geometry_cells(first)
    second_cells = _geometry_cells(second)
    if not first_cells or not second_cells:
        return 0.0
    return len(first_cells & second_cells) / len(first_cells | second_cells)


def _geometry_cells(geometry: dict[str, Any]) -> frozenset[tuple[int, int]]:
    # 0.001 degree cells (~100 m).  This is deliberately a coarse diversity
    # filter, not a geographic correctness proof.
    return frozenset(
        (round(float(point[1]) * 1_000), round(float(point[0]) * 1_000))
        for point in geometry.get("coordinates") or []
        if len(point) >= 2
    )


def _haversine_m(first_lat: float, first_lon: float, second_lat: float, second_lon: float) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (first_lat, first_lon, second_lat, second_lon))
    value = math.sin((lat2 - lat1) / 2) ** 2
    value += math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.asin(math.sqrt(value))
