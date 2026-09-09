from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from demo.osm_cycling_router.places import (
    Place,
    build_index,
    create_schema,
    insert_place,
    nearby_scenic_places,
    scenic_category,
    search_places,
)


class ScenicPlaceIndexTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "places.sqlite"
        import sqlite3
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        create_schema(connection)
        insert_place(connection, Place("way", 1, "淀山湖", "lake", 31.12, 120.99, {"natural": "water"}))
        insert_place(connection, Place("node", 2, "湖州观景台", "viewpoint", 31.13, 121.01, {"tourism": "viewpoint"}))
        insert_place(connection, Place("node", 3, "朱家角镇", "settlement", 31.11, 121.05, {"place": "town"}))
        connection.commit()
        connection.close()

    def tearDown(self):
        self.directory.cleanup()

    def test_category_selection_ignores_unimportant_objects(self):
        self.assertEqual(scenic_category({"amenity": "restaurant"}), None)
        self.assertEqual(scenic_category({"natural": "water", "water": "lake"}), "lake")
        self.assertEqual(scenic_category({"tourism": "viewpoint"}), "viewpoint")

    def test_search_prefers_exact_name_and_nearby_match(self):
        results = search_places(self.database, "淀山湖", near=(31.12, 121.0))
        self.assertEqual([item.name for item in results], ["淀山湖"])
        self.assertEqual(results[0].category, "lake")
        self.assertLess(results[0].distance_m or 0, 2_000)

    def test_nearby_returns_only_scenic_categories_inside_radius(self):
        results = nearby_scenic_places(self.database, lat=31.12, lon=121.0, radius_m=2_000)
        self.assertEqual([item.category for item in results], ["lake", "viewpoint"])

    def test_build_index_reads_named_nodes_and_ways(self):
        fixture = Path(__file__).with_name("fixtures") / "scenic.osm"
        database = Path(self.directory.name) / "built.sqlite"
        self.assertEqual(build_index(fixture, database), 2)
        self.assertEqual(
            [item.category for item in nearby_scenic_places(database, lat=31.13, lon=121.02, radius_m=3_000)],
            ["lake", "viewpoint"],
        )


if __name__ == "__main__":
    unittest.main()
