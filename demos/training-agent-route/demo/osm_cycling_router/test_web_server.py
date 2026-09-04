from __future__ import annotations

import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

from demo.osm_cycling_router.places import build_index
from demo.osm_cycling_router.web_server import create_server


class WebServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.database = root / "places.sqlite"
        self.route_probe_dir = root / "route-probes"
        self.route_probe_dir.mkdir()
        (self.route_probe_dir / "sample.geojson").write_text(json.dumps({
            "type": "FeatureCollection", "metadata": {"name": "sample"}, "features": [],
        }), encoding="utf-8")
        fixture = Path(__file__).with_name("fixtures") / "scenic.osm"
        build_index(fixture, self.database)
        self.server = create_server(
            host="127.0.0.1",
            port=0,
            static_dir=Path(__file__).with_name("web"),
            database=self.database,
            graphhopper_url="http://127.0.0.1:9",
            route_probe_dir=self.route_probe_dir,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.opener = build_opener(ProxyHandler({}))
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp_dir.cleanup()

    def get_json(self, path: str) -> dict[str, object]:
        with self.opener.open(f"{self.base_url}{path}") as response:
            return json.load(response)

    def test_health_and_static_index(self) -> None:
        self.assertEqual(self.get_json("/health"), {"status": "ok"})
        with self.opener.open(f"{self.base_url}/") as response:
            self.assertIn(b"OSM", response.read())

    def test_search_and_nearby_endpoints(self) -> None:
        search = self.get_json("/api/places/search?q=%E6%B5%8B%E8%AF%95%E6%B9%96&near=31.1,121.0")
        self.assertEqual(search["places"][0]["name"], "测试湖")
        nearby = self.get_json("/api/places/nearby?point=31.13,121.02&radius_m=3000")
        self.assertEqual(nearby["places"][0]["category"], "lake")

    def test_rejects_invalid_route_profile_without_proxying(self) -> None:
        with self.assertRaises(HTTPError) as error:
            self.opener.open(f"{self.base_url}/api/route?point=31,121&point=31.1,121.1&profile=plane")
        self.assertEqual(error.exception.code, 400)

    def test_rejects_free_loop_without_target_distance(self) -> None:
        with self.assertRaises(HTTPError) as error:
            self.opener.open(f"{self.base_url}/api/free-loop?point=31,121")
        self.assertEqual(error.exception.code, 400)

    def test_reads_only_named_local_route_probe(self) -> None:
        self.assertEqual(self.get_json("/api/route-probes/sample")["metadata"]["name"], "sample")
        with self.assertRaises(HTTPError) as error:
            self.opener.open(f"{self.base_url}/api/route-probes/../sample")
        self.assertEqual(error.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
