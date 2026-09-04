"""Plan an approach road plus a local loop around a named riding area.

The route is intentionally split into three parts::

    origin -> area gateway -> local loop -> origin

The approach and return roads still count towards total distance, but their
expected overlap is *not* treated as a defect of the local loop.  This keeps a
city-to-mountain route from losing to a shorter but less useful route merely
because both directions share a sensible access road.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .router import Point, route_points
except ImportError:  # pragma: no cover - direct Docker invocation
    from router import Point, route_points


RouteFetcher = Callable[..., dict[str, Any]]


def _geometry(result: dict[str, Any]) -> tuple[tuple[float, float], ...]:
    coordinates = ((result.get("raw") or {}).get("paths") or [{}])[0].get("points", {}).get("coordinates") or []
    if len(coordinates) < 2:
        raise ValueError("GraphHopper result contains insufficient route geometry")
    return tuple((float(lon), float(lat)) for lon, lat in coordinates)


def _join_geometries(geometries: Sequence[Sequence[tuple[float, float]]]) -> list[list[float]]:
    joined: list[list[float]] = []
    for geometry in geometries:
        for lon, lat in geometry:
            point = [lon, lat]
            if not joined or joined[-1] != point:
                joined.append(point)
    if len(joined) < 2:
        raise ValueError("route contains insufficient geometry")
    return joined


def _cells(geometry: Sequence[tuple[float, float]]) -> frozenset[tuple[int, int]]:
    return frozenset((round(lat * 1_000), round(lon * 1_000)) for lon, lat in geometry)


def _local_retrace_ratio(leg_geometries: Sequence[Sequence[tuple[float, float]]]) -> float:
    """Approximate duplicate use inside the area loop only, at ~100 m scale."""
    counts: Counter[tuple[int, int]] = Counter()
    for geometry in leg_geometries:
        counts.update(_cells(geometry))
    traversals = sum(counts.values())
    duplicate_cells = sum(count - 1 for count in counts.values())
    # A perimeter loop naturally joins the end of each leg to the start of
    # the next one, and its final leg joins the first one at the gateway.
    # Those shared endpoints are not an out-and-back retrace.
    expected_joins = sum(
        1
        for first, second in zip(leg_geometries, leg_geometries[1:])
        if _cells((first[-1],)) == _cells((second[0],))
    )
    if leg_geometries and _cells((leg_geometries[-1][-1],)) == _cells((leg_geometries[0][0],)):
        expected_joins += 1
    return max(0, duplicate_cells - expected_joins) / max(1, traversals)


@dataclass(frozen=True)
class LollipopCandidate:
    direction: str
    local_distance_m: float
    local_retrace_ratio: float
    geometry: tuple[tuple[float, float], ...]
    local_geometry: tuple[tuple[float, float], ...]
    local_waypoints: tuple[Point, ...]

    def as_dict(self, *, approach_out_m: float, approach_back_m: float) -> dict[str, Any]:
        return {
            "direction": self.direction,
            "approach_out_m": round(approach_out_m, 1),
            "approach_back_m": round(approach_back_m, 1),
            "local_distance_m": round(self.local_distance_m, 1),
            "total_distance_m": round(approach_out_m + self.local_distance_m + approach_back_m, 1),
            "local_retrace_ratio": round(self.local_retrace_ratio, 4),
            "local_waypoints": [{"lat": point.lat, "lon": point.lon} for point in self.local_waypoints],
        }


@dataclass(frozen=True)
class LollipopPlan:
    origin: Point
    gateway: Point
    profile: str
    approach_out_m: float
    approach_back_m: float
    approach_out_geometry: tuple[tuple[float, float], ...]
    approach_back_geometry: tuple[tuple[float, float], ...]
    candidates: tuple[LollipopCandidate, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "lollipop_loop_plan.v1",
            "origin": {"lat": self.origin.lat, "lon": self.origin.lon},
            "gateway": {"lat": self.gateway.lat, "lon": self.gateway.lon},
            "profile": self.profile,
            "approach_out_m": round(self.approach_out_m, 1),
            "approach_back_m": round(self.approach_back_m, 1),
            "candidates": [item.as_dict(approach_out_m=self.approach_out_m, approach_back_m=self.approach_back_m) for item in self.candidates],
        }


def plan_lollipop_loop(
    origin: Point,
    gateway: Point,
    *,
    ring_waypoints: Sequence[Point],
    profile: str = "racingbike",
    fetcher: RouteFetcher = route_points,
) -> LollipopPlan:
    """Calculate a reusable approach road and clockwise/counter-clockwise area loops.

    ``ring_waypoints`` must follow the local perimeter in one direction and
    intentionally excludes ``gateway``.  The planner retains both directions
    even if they share roads: this first version makes that tradeoff visible
    rather than silently claiming a directional preference.
    """
    if len(ring_waypoints) < 2:
        raise ValueError("ring_waypoints requires at least two perimeter points")

    approach_out = fetcher((origin, gateway), profile=profile)
    approach_back = fetcher((gateway, origin), profile=profile)
    approach_out_geometry = _geometry(approach_out)
    approach_back_geometry = _geometry(approach_back)
    candidates: list[LollipopCandidate] = []
    for direction, waypoints in (
        ("clockwise", tuple(ring_waypoints)),
        ("counterclockwise", tuple(reversed(ring_waypoints))),
    ):
        chain = (gateway, *waypoints, gateway)
        leg_results = [fetcher((first, second), profile=profile) for first, second in zip(chain, chain[1:])]
        leg_geometries = tuple(_geometry(item) for item in leg_results)
        local_geometry = tuple(tuple(point) for point in _join_geometries(leg_geometries))
        full_geometry = tuple(tuple(point) for point in _join_geometries((approach_out_geometry, local_geometry, approach_back_geometry)))
        candidates.append(LollipopCandidate(
            direction=direction,
            local_distance_m=sum(float(item["distance_m"]) for item in leg_results),
            local_retrace_ratio=_local_retrace_ratio(leg_geometries),
            geometry=full_geometry,
            local_geometry=local_geometry,
            local_waypoints=waypoints,
        ))

    return LollipopPlan(
        origin=origin,
        gateway=gateway,
        profile=profile,
        approach_out_m=float(approach_out["distance_m"]),
        approach_back_m=float(approach_back["distance_m"]),
        approach_out_geometry=approach_out_geometry,
        approach_back_geometry=approach_back_geometry,
        candidates=tuple(sorted(candidates, key=lambda item: (item.local_retrace_ratio, item.local_distance_m, item.direction))),
    )


def lollipop_geojson(plan: LollipopPlan, *, name: str) -> dict[str, Any]:
    """Make full, comparable routes ready for the existing local Leaflet demo."""
    colors = {"clockwise": "#d64f3b", "counterclockwise": "#2d7dd2"}
    features = []
    for index, candidate in enumerate(plan.candidates, start=1):
        facts = candidate.as_dict(approach_out_m=plan.approach_out_m, approach_back_m=plan.approach_back_m)
        features.append({
            "type": "Feature",
            "properties": {
                "kind": "graphhopper_candidate",
                "name": f"候选 {index} · {'顺时针' if candidate.direction == 'clockwise' else '逆时针'}区域环线",
                "color": colors[candidate.direction],
                "distance_m": facts["total_distance_m"],
                "approach_out_m": facts["approach_out_m"],
                "approach_back_m": facts["approach_back_m"],
                "local_distance_m": facts["local_distance_m"],
                "local_retrace_ratio": facts["local_retrace_ratio"],
                "profile": plan.profile,
            },
            "geometry": {"type": "LineString", "coordinates": candidate.geometry},
        })
    return {
        "type": "FeatureCollection",
        "metadata": {
            "name": name,
            "candidate_count": len(plan.candidates),
            "start_latlng": [plan.origin.lat, plan.origin.lon],
            "end_latlng": [plan.origin.lat, plan.origin.lon],
            "closure_gap_m": 0,
            "gateway_latlng": [plan.gateway.lat, plan.gateway.lon],
            "approach_out_m": round(plan.approach_out_m, 1),
            "approach_back_m": round(plan.approach_back_m, 1),
            "candidate_min_distance_m": round(min(item.as_dict(approach_out_m=plan.approach_out_m, approach_back_m=plan.approach_back_m)["total_distance_m"] for item in plan.candidates), 1),
            "candidate_max_distance_m": round(max(item.as_dict(approach_out_m=plan.approach_out_m, approach_back_m=plan.approach_back_m)["total_distance_m"] for item in plan.candidates), 1),
            "profile": plan.profile,
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
    parser = argparse.ArgumentParser(description="Plan a city approach plus a local perimeter loop")
    parser.add_argument("--start", type=_point, required=True)
    parser.add_argument("--gateway", type=_point, required=True, help="entry/exit point on the area perimeter")
    parser.add_argument("--via", type=_point, action="append", required=True, help="perimeter points in one direction, repeatable")
    parser.add_argument("--profile", choices=("car", "bike", "racingbike"), default="racingbike")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--name", default="干线 + 区域环线（实验）")
    args = parser.parse_args()
    plan = plan_lollipop_loop(args.start, args.gateway, ring_waypoints=args.via, profile=args.profile)
    geojson = lollipop_geojson(plan, name=args.name)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(geojson, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(plan.as_dict(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
