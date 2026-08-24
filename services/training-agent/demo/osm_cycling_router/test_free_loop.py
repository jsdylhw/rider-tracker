from __future__ import annotations

import unittest

from demo.osm_cycling_router.free_loop import plan_free_loop
from demo.osm_cycling_router.router import Point


def fake_round_trip(origin: Point, *, distance_m: float, seed: int, profile: str, base_url: str) -> dict[str, object]:
    del origin, profile, base_url
    geometries = {
        0: [[121.0000, 30.0000], [121.0100, 30.0000], [121.0100, 30.0100], [121.0000, 30.0000]],
        # Same coarse geometry as seed 0: it should be deduplicated.
        1: [[121.0001, 30.0001], [121.0101, 30.0000], [121.0100, 30.0101], [121.0001, 30.0001]],
        2: [[121.0000, 30.0000], [121.0200, 30.0000], [121.0200, 30.0200], [121.0000, 30.0000]],
        3: [[121.0000, 30.0000], [120.9900, 30.0000], [120.9900, 30.0120], [121.0000, 30.0000]],
    }
    actual_distance = {0: distance_m, 1: distance_m * 1.02, 2: distance_m * 1.35, 3: distance_m * 1.08}[seed]
    return {
        "profile": "racingbike",
        "distance_m": actual_distance,
        "duration_s": 2_000,
        "ascend_m": 50,
        "details": {},
        "raw": {"paths": [{"points": {"coordinates": geometries[seed]}}]},
    }


class FreeLoopPlanTest(unittest.TestCase):
    def test_filters_distance_outliers_and_near_duplicates(self) -> None:
        plan = plan_free_loop(
            Point(30.0, 121.0),
            target_distance_m=10_000,
            seeds=(0, 1, 2, 3),
            max_candidates=2,
            fetch_round_trip=fake_round_trip,
        )

        self.assertEqual([candidate.seed for candidate in plan.candidates], [0, 3])
        self.assertEqual(plan.candidates[0].distance_error_ratio, 0.0)
        self.assertEqual(plan.candidates[0].start_end_gap_m, 0.0)
        self.assertIn({"seed": 1, "reason": "near_duplicate"}, plan.rejected)
        self.assertIn({"seed": 2, "reason": "distance_out_of_tolerance", "distance_m": 13500.0}, plan.rejected)

    def test_rejects_invalid_plan_limits_before_routing(self) -> None:
        with self.assertRaisesRegex(ValueError, "distance_tolerance"):
            plan_free_loop(
                Point(30.0, 121.0), target_distance_m=10_000, distance_tolerance=0,
                fetch_round_trip=fake_round_trip,
            )


if __name__ == "__main__":
    unittest.main()
