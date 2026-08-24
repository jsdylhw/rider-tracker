from __future__ import annotations

import unittest

from demo.gaode_cycling_router.route_evidence import Bounds, assess_loop_evidence, discover_segment_evidence, validate_route_candidate


def feature(points: list[list[float]]) -> dict:
    return {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": points}}


class RouteEvidenceTests(unittest.TestCase):
    def test_discovery_tiles_and_deduplicates_explorer_results(self) -> None:
        calls: list[str] = []

        def explore(bounds: str, _: str) -> dict:
            calls.append(bounds)
            return {"segment_count": 2, "segments": [{"id": 2, "distance": 100}, {"id": len(calls), "distance": 200}]}

        result = discover_segment_evidence(Bounds(0, 0, 2, 2), "token", explorer=explore)
        self.assertEqual(len(calls), 4)
        self.assertEqual(result["unique_segment_count"], 4)
        segment_one = next(item for item in result["segments"] if item["id"] == 1)
        self.assertEqual(segment_one["discovered_in_tiles"], [0])
        segment_two = next(item for item in result["segments"] if item["id"] == 2)
        self.assertEqual(segment_two["discovered_in_tiles"], [0, 1, 2, 3])

    def test_evidence_refuses_partial_perimeter_even_if_segments_join(self) -> None:
        result = assess_loop_evidence([
            feature([[0.02, 0.9], [0.02, 0.1]]),
            feature([[0.02, 0.1], [0.5, 0.1]]),
        ], Bounds(0, 0, 1, 1), join_gap_m=10_000)
        self.assertEqual(result["status"], "insufficient_perimeter_evidence")
        self.assertIn("east", result["missing_sides"])

    def test_geometry_far_below_the_target_does_not_fake_south_coverage(self) -> None:
        result = assess_loop_evidence([
            feature([[0.05, 0.5], [0.95, 0.5]]),
            # It is south of the target, but not adjacent to its south side.
            feature([[0.05, -1.0], [0.95, -1.0]]),
        ], Bounds(0, 0, 1, 1), join_gap_m=10_000)
        self.assertEqual(result["status"], "insufficient_perimeter_evidence")
        self.assertIn("south", result["missing_sides"])

    def test_evidence_accepts_connected_geometry_touching_all_target_sides(self) -> None:
        result = assess_loop_evidence([
            feature([[0.05, 0.05], [0.95, 0.05]]),
            feature([[0.95, 0.05], [0.95, 0.95]]),
            feature([[0.95, 0.95], [0.05, 0.95]]),
            feature([[0.05, 0.95], [0.05, 0.05]]),
        ], Bounds(0, 0, 1, 1), join_gap_m=10_000)
        self.assertEqual(result["status"], "skeleton_candidate")
        validation = validate_route_candidate(
            distance_m=70_000, closure_gap_m=5, retrace_ratio=.1,
            min_distance_m=60_000, max_distance_m=80_000, loop_evidence=result,
        )
        self.assertTrue(validation["accepted"])


if __name__ == "__main__":
    unittest.main()
