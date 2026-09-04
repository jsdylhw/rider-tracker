from __future__ import annotations

import unittest

from demo.osm_cycling_router.road_corridors import RoadCorridor
from demo.osm_cycling_router.route_candidates import (
    ConnectorCandidate,
    candidate_routes_geojson,
    connector_candidates,
    plan_candidate_loops,
)
from demo.osm_cycling_router.router import Point
from demo.osm_cycling_router.segment_loop import DirectedSegment


def _result(points, distance_m, way_ids=()):
    return {"distance_m": distance_m, "details": {"osm_way_id": [[0, len(points) - 1, item] for item in way_ids]}, "raw": {"paths": [{"points": {"coordinates": [[point.lon, point.lat] for point in points]}}]}}


class RouteCandidateTests(unittest.TestCase):
    def test_connector_candidates_keeps_direct_and_partial_corridor_option(self):
        corridor = RoadCorridor("春风十里路", "YBA4", ("secondary",), (99,), (), ((30.1, 120.1),), None)

        def fetch(points, *, profile):
            return _result(points, 1_000 if len(points) == 2 else 1_200, (99,) if len(points) == 3 else ())

        candidates = connector_candidates(Point(30.0, 120.0), Point(30.2, 120.2), corridors=(corridor,), fetcher=fetch)
        self.assertEqual(len(candidates), 2)
        self.assertTrue(candidates[0].is_direct)
        self.assertEqual(candidates[1].corridor_ref, "YBA4")

    def test_global_search_returns_diverse_connector_choices(self):
        segments = (
            DirectedSegment(1, "甲", ((120.1, 30.0), (120.2, 30.0)), 1_000, 100, {}),
            DirectedSegment(2, "乙", ((120.3, 30.0), (120.4, 30.0)), 1_000, 100, {}),
        )
        def build(origin, destination):
            scenic_point = Point((origin.lat + destination.lat) / 2 + 0.02, (origin.lon + destination.lon) / 2)
            direct = ConnectorCandidate(origin, destination, ((origin.lon, origin.lat), (destination.lon, destination.lat)), 1_000)
            scenic = ConnectorCandidate(
                origin, destination,
                ((origin.lon, origin.lat), (scenic_point.lon, scenic_point.lat), (destination.lon, destination.lat)),
                1_250, corridor_name="春风十里路", corridor_ref="YBA4", corridor_coverage_way_ids=frozenset({99}),
            )
            return [
                direct, scenic,
            ]
        routes = plan_candidate_loops(segments, start=Point(30.0, 120.0), target_distance_m=6_000, connector_builder=build, max_routes=2)
        self.assertEqual(len(routes), 2)
        self.assertTrue(all(len(item.connectors) == 3 for item in routes))
        self.assertEqual(routes[0].corridor_count, 0)
        self.assertTrue(any(item.corridor_count == 1 for item in routes))

        geojson = candidate_routes_geojson(
            routes, name="测试候选", start=Point(30.0, 120.0), target_distance_m=6_000,
        )
        self.assertEqual(geojson["metadata"]["candidate_count"], 2)
        self.assertEqual(geojson["features"][0]["properties"]["kind"], "graphhopper_candidate")
        self.assertGreaterEqual(len(geojson["features"][0]["geometry"]["coordinates"]), 2)
