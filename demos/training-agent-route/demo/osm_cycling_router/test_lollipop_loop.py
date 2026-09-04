from __future__ import annotations

import unittest

from demo.osm_cycling_router.lollipop_loop import lollipop_geojson, plan_lollipop_loop
from demo.osm_cycling_router.router import Point


def fake_route(points, *, profile):
    del profile
    coordinates = [[point.lon, point.lat] for point in points]
    distance = sum(1_000 + index * 100 for index, _ in enumerate(points[1:]))
    return {"distance_m": distance, "raw": {"paths": [{"points": {"coordinates": coordinates}}]}}


class LollipopLoopTests(unittest.TestCase):
    def test_reuses_approach_and_scores_only_local_retrace(self) -> None:
        origin = Point(30.0, 120.0)
        gateway = Point(30.1, 120.0)
        plan = plan_lollipop_loop(
            origin, gateway,
            ring_waypoints=(Point(30.1, 120.1), Point(30.0, 120.1)),
            fetcher=fake_route,
        )

        self.assertEqual(len(plan.candidates), 2)
        self.assertEqual(plan.approach_out_m, 1_000)
        self.assertEqual(plan.approach_back_m, 1_000)
        self.assertEqual(plan.candidates[0].local_distance_m, 3_000)
        self.assertEqual(plan.candidates[0].local_retrace_ratio, 0.0)
        self.assertTrue(all(candidate.geometry[0] == (120.0, 30.0) for candidate in plan.candidates))

    def test_geojson_exposes_shared_approach_separately_from_local_loop(self) -> None:
        plan = plan_lollipop_loop(
            Point(30.0, 120.0), Point(30.1, 120.0),
            ring_waypoints=(Point(30.1, 120.1), Point(30.0, 120.1)), fetcher=fake_route,
        )
        geojson = lollipop_geojson(plan, name="测试区域")

        self.assertEqual(geojson["metadata"]["candidate_count"], 2)
        self.assertEqual(geojson["metadata"]["candidate_min_distance_m"], 5_000)
        self.assertEqual(geojson["metadata"]["candidate_max_distance_m"], 5_000)
        self.assertEqual(geojson["features"][0]["properties"]["approach_out_m"], 1_000)
        self.assertIn("local_retrace_ratio", geojson["features"][0]["properties"])


if __name__ == "__main__":
    unittest.main()
