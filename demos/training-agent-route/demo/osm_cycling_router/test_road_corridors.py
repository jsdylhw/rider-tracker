from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from demo.osm_cycling_router.road_corridors import (
    build_index,
    decode_geometry,
    encode_geometry,
    nearby_road_corridors,
    search_road_corridors,
    simplify_geometry,
)


class RoadCorridorIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "roads.sqlite"
        self.fixture = Path(__file__).with_name("fixtures") / "scenic.osm"

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_geometry_encoding_and_simplification_keep_endpoints(self) -> None:
        original = ((31.0, 120.0), (31.000001, 120.000001), (31.01, 120.01))
        simplified = simplify_geometry(original, tolerance_m=5)
        self.assertEqual(simplified, (original[0], original[-1]))
        self.assertEqual(decode_geometry(encode_geometry(simplified)), simplified)

    def test_build_and_search_by_road_name_or_ref(self) -> None:
        self.assertEqual(build_index(self.fixture, self.database), 2)
        by_name = search_road_corridors(self.database, "春风十里")
        self.assertEqual(len(by_name), 1)
        self.assertEqual(by_name[0].name, "春风十里路")
        self.assertEqual(by_name[0].ref, "YBA4")
        self.assertEqual(len(by_name[0].osm_way_ids), 2)
        self.assertEqual(search_road_corridors(self.database, "YBA4")[0].relation_ids, (30,))

    def test_nearby_returns_simplified_corridor_with_anchors(self) -> None:
        build_index(self.fixture, self.database)
        nearby = nearby_road_corridors(self.database, lat=31.156, lon=121.046, radius_m=2_000)
        self.assertEqual(len(nearby), 1)
        self.assertEqual(nearby[0].ref, "YBA4")
        self.assertLess(nearby[0].distance_m or float("inf"), 300)
        self.assertGreaterEqual(len(nearby[0].anchors), 3)


if __name__ == "__main__":
    unittest.main()
