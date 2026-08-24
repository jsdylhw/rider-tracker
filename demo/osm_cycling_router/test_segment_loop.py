from __future__ import annotations

import unittest

from demo.osm_cycling_router.router import Point
from demo.osm_cycling_router.segment_loop import DirectedSegment, plan_ordered_segment_route, plan_segment_loop, reverse_segment


def segment(name: str, start: tuple[float, float], end: tuple[float, float]) -> DirectedSegment:
    return DirectedSegment(None, name, (start, end), 1_000, 100, {})


class SegmentLoopTests(unittest.TestCase):
    def test_reverse_segment_reverses_geometry_and_excludes_ascent(self) -> None:
        original = segment("climb", (120.0, 30.0), (120.1, 30.0))
        reversed_segment = reverse_segment(original)

        self.assertEqual(reversed_segment.geometry, ((120.1, 30.0), (120.0, 30.0)))
        self.assertEqual(reversed_segment.ascend_m, 0)
        self.assertEqual(reversed_segment.properties["route_direction"], "reverse")

    def test_prefers_order_with_shorter_connectors(self) -> None:
        first = segment("first", (120.0, 30.0), (120.1, 30.0))
        second = segment("second", (120.2, 30.0), (120.3, 30.0))
        third = segment("third", (120.4, 30.0), (120.5, 30.0))
        locations = {(120.1, 30.0, 120.2, 30.0): 1_000, (120.3, 30.0, 120.4, 30.0): 1_000, (120.5, 30.0, 120.0, 30.0): 1_000}

        def connector(origin: Point, destination: Point):
            key = (round(origin.lon, 1), round(origin.lat, 1), round(destination.lon, 1), round(destination.lat, 1))
            distance = locations.get(key, 20_000)
            return {"distance_m": distance, "ascend_m": 0, "details": {}, "raw": {"paths": [{"points": {"coordinates": [[origin.lon, origin.lat], [destination.lon, destination.lat]]}}]}}

        result = plan_segment_loop([first, second, third], target_distance_m=6_000, connector_fetcher=connector, max_candidates=1)[0]
        self.assertEqual([item.name for item in result.segments], ["first", "second", "third"])
        self.assertEqual(result.total_distance_m, 6_000)

    def test_reverse_direction_can_reduce_connector_cost(self) -> None:
        first = segment("first", (120.0, 30.0), (120.1, 30.0))
        second = segment("second", (120.2, 30.0), (120.3, 30.0))

        def connector(origin: Point, destination: Point):
            # The second segment only joins efficiently when it is travelled
            # in reverse: first end -> second end -> second start -> first start.
            key = (round(origin.lon, 1), round(destination.lon, 1))
            distance = 1_000 if key in {(120.1, 120.3), (120.2, 120.0)} else 20_000
            return {"distance_m": distance, "ascend_m": 0, "details": {}, "raw": {"paths": [{"points": {"coordinates": [[origin.lon, origin.lat], [destination.lon, destination.lat]]}}]}}

        result = plan_segment_loop(
            [first, second], target_distance_m=4_000, connector_fetcher=connector,
            allow_reverse=True, max_candidates=1,
        )[0]

        self.assertEqual(result.total_distance_m, 4_000)
        self.assertTrue(any(item.properties.get("route_direction") == "reverse" for item in result.segments))

    def test_fixed_start_is_routed_before_and_after_segment_loop(self) -> None:
        first = segment("first", (120.0, 30.0), (120.1, 30.0))
        second = segment("second", (120.2, 30.0), (120.3, 30.0))

        def connector(origin: Point, destination: Point):
            return {
                "distance_m": 1_000,
                "ascend_m": 0,
                "details": {},
                "raw": {"paths": [{"points": {"coordinates": [[origin.lon, origin.lat], [destination.lon, destination.lat]]}}]},
            }

        result = plan_segment_loop(
            [first, second], target_distance_m=6_000, connector_fetcher=connector,
            max_candidates=1, start=Point(30.0, 119.9), start_name="径山镇",
        )[0]

        self.assertIsNotNone(result.entry_connector)
        self.assertEqual(result.entry_connector.source.name, "径山镇")
        self.assertEqual(result.total_distance_m, 5_000)

    def test_one_closed_segment_can_be_connected_to_a_fixed_city_start(self) -> None:
        loop = segment("已知完整环线", (120.0, 30.0), (120.0, 30.0))

        def connector(origin: Point, destination: Point):
            return {
                "distance_m": 1_000,
                "ascend_m": 0,
                "details": {},
                "raw": {"paths": [{"points": {"coordinates": [[origin.lon, origin.lat], [destination.lon, destination.lat]]}}]},
            }

        result = plan_segment_loop(
            [loop], target_distance_m=3_000, connector_fetcher=connector,
            max_candidates=1, start=Point(30.1, 119.9), start_name="城市起点",
        )[0]

        self.assertEqual(result.total_distance_m, 3_000)
        self.assertEqual(result.connector_distance_m, 2_000)
        self.assertEqual(len(result.connectors), 1)

    def test_ordered_route_keeps_verified_access_segment_before_local_loop(self) -> None:
        bridge = segment("夹江大桥（东往西）", (120.0, 30.0), (120.1, 30.0))
        loop = segment("江心洲闭环", (120.2, 30.0), (120.2, 30.0))

        def connector(origin: Point, destination: Point):
            return {
                "distance_m": 1_000,
                "ascend_m": 0,
                "details": {},
                "raw": {"paths": [{"points": {"coordinates": [[origin.lon, origin.lat], [destination.lon, destination.lat]]}}]},
            }

        result = plan_ordered_segment_route(
            [bridge, loop], start=Point(30.0, 119.9), target_distance_m=5_000,
            connector_fetcher=connector, start_name="夫子庙",
        )

        self.assertEqual([item.name for item in result.segments], ["夹江大桥（东往西）", "江心洲闭环"])
        self.assertEqual(result.total_distance_m, 5_000)
        self.assertEqual(result.entry_connector.source.name, "夫子庙")

    def test_ordered_route_can_rotate_closed_loop_at_a_short_observed_handoff(self) -> None:
        bridge = segment("桥", (120.0, 30.0), (120.12, 30.0))
        loop = DirectedSegment(2, "闭环", ((120.11, 30.0), (120.12, 30.0), (120.11, 30.0)), 1_000, 0, {})
        calls = []

        def connector(origin: Point, destination: Point):
            calls.append((origin, destination))
            return {
                "distance_m": 1_000,
                "ascend_m": 0,
                "details": {},
                "raw": {"paths": [{"points": {"coordinates": [[origin.lon, origin.lat], [destination.lon, destination.lat]]}}]},
            }

        result = plan_ordered_segment_route(
            [bridge, loop], start=Point(30.0, 119.9), target_distance_m=4_000,
            connector_fetcher=connector, near_handoff_m=100,
        )

        self.assertEqual(len(calls), 2)  # city -> bridge and loop -> city only
        self.assertEqual(result.segments[1].geometry[0], (120.12, 30.0))
        self.assertEqual(result.connectors[0].details["kind"], "strava_handoff_gap")


if __name__ == "__main__":
    unittest.main()
