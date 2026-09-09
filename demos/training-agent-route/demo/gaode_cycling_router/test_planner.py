from __future__ import annotations

import unittest

from demo.gaode_cycling_router.amap import AmapCyclingRouter, AmapPoint
from demo.gaode_cycling_router.planner import candidate_preview_feature, plan_ordered_wgs84_segments_with_amap
from demo.osm_cycling_router.router import Point
from demo.osm_cycling_router.segment_loop import DirectedSegment, candidate_geojson


class PlannerAdapterTests(unittest.TestCase):
    def test_reuses_ordered_skeleton_planner_with_amap_bicycle_connectors(self) -> None:
        class StubRouter(AmapCyclingRouter):
            def __init__(self) -> None:
                self.calls: list[tuple[AmapPoint, AmapPoint]] = []

            def route(self, origin: AmapPoint, destination: AmapPoint):  # type: ignore[override]
                self.calls.append((origin, destination))
                return {
                    "provider": "amap", "profile": "bicycling", "distance_m": 100.0, "duration_s": 20.0,
                    "ascend_m": None, "geometry": [(origin.lon, origin.lat), (destination.lon, destination.lat)],
                    "instructions": [], "raw": {},
                }

        segment = DirectedSegment(
            segment_id=1, name="示例骨架", geometry=((118.70, 32.03), (118.71, 32.04)),
            distance_m=1_500, ascend_m=20, properties={"id": 1},
        )
        router = StubRouter()
        candidate = plan_ordered_wgs84_segments_with_amap(
            [segment], start=Point(32.02, 118.78), target_distance_m=2_000, router=router,
        )
        self.assertEqual(len(router.calls), 2)
        self.assertEqual(candidate.entry_connector.details["provider"], "amap")
        self.assertEqual(candidate.entry_connector.details["mode"], "bicycling")
        # The adapter changed the WGS-84 source into GCJ-02 before calling AMap.
        self.assertNotAlmostEqual(router.calls[0][1].lon, 118.70, places=4)
        geojson = candidate_geojson(candidate, name="高德测试", target_distance_m=2_000)
        connector_kinds = [item["properties"]["kind"] for item in geojson["features"] if item["properties"].get("distance_m") == 100.0]
        self.assertEqual(connector_kinds, ["amap_bicycling_connector", "amap_bicycling_connector"])
        preview = candidate_preview_feature(candidate, index=1, name="测试候选", min_distance_m=1_000, max_distance_m=2_000)
        self.assertEqual(preview["properties"]["kind"], "amap_bicycling_candidate")
        self.assertTrue(preview["properties"]["within_requested_distance"])
        self.assertGreaterEqual(len(preview["geometry"]["coordinates"]), 2)


if __name__ == "__main__":
    unittest.main()
