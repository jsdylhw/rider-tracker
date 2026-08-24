from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

from demo.gaode_cycling_router.amap import AmapPoint
from demo.gaode_cycling_router.web_server import create_server, load_probe_as_gcj02


class StubRouter:
    def route(self, origin: AmapPoint, destination: AmapPoint):
        return {
            "provider": "amap", "profile": "bicycling", "distance_m": 123.0, "duration_s": 45.0,
            "ascend_m": None, "geometry": [(origin.lon, origin.lat), (destination.lon, destination.lat)],
            "instructions": [], "raw": {},
        }


class GaodeWebServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.static_dir = root / "web"
        self.static_dir.mkdir()
        (self.static_dir / "index.html").write_text("demo", encoding="utf-8")
        self.probe_dir = root / "probes"
        self.probe_dir.mkdir()
        (self.probe_dir / "sample.geojson").write_text(json.dumps({
            "type": "FeatureCollection", "metadata": {}, "features": [{
                "type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [[118.7, 32.0], [118.71, 32.01]]},
            }],
        }), encoding="utf-8")
        self.server = create_server(
            host="127.0.0.1", port=0, static_dir=self.static_dir, router=StubRouter(),
            js_key="js-demo-key", security_js_code="security-demo", route_probe_dir=self.probe_dir,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.opener = build_opener(ProxyHandler({}))

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join()
        self.tempdir.cleanup()

    def request_json(self, path: str) -> dict:
        with self.opener.open(f"{self.base_url}{path}") as response:
            return json.load(response)

    def test_route_uses_gcj_points_and_keeps_web_service_key_server_side(self) -> None:
        payload = self.request_json("/api/route?origin=118.7,32.0&destination=118.8,32.1")
        self.assertEqual(payload["distance_m"], 123.0)
        self.assertNotIn("key", json.dumps(payload))

    def test_config_only_exposes_the_js_map_credentials(self) -> None:
        self.assertEqual(self.request_json("/api/config"), {
            "js_key": "js-demo-key", "security_js_code": "security-demo", "coordinate_system": "gcj02",
        })

    def test_probe_is_converted_from_wgs84_before_map_rendering(self) -> None:
        payload = self.request_json("/api/route-probes/sample")
        coordinate = payload["features"][0]["geometry"]["coordinates"][0]
        self.assertNotEqual(coordinate, [118.7, 32.0])
        self.assertEqual(payload["metadata"]["coordinate_system"], "gcj02")

    def test_rejects_path_traversal(self) -> None:
        with self.assertRaises(HTTPError) as error:
            self.opener.open(f"{self.base_url}/api/route-probes/../sample")
        self.assertEqual(error.exception.code, 400)

    def test_keeps_a_preconverted_gcj02_probe_unchanged(self) -> None:
        (self.probe_dir / "already-gcj.geojson").write_text(json.dumps({
            "type": "FeatureCollection", "metadata": {"coordinate_system": "gcj02"}, "features": [{
                "type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [[118.7, 32.0], [118.71, 32.01]]},
            }],
        }), encoding="utf-8")
        payload = load_probe_as_gcj02(self.probe_dir, "already-gcj")
        self.assertEqual(payload["features"][0]["geometry"]["coordinates"][0], [118.7, 32.0])


if __name__ == "__main__":
    unittest.main()
