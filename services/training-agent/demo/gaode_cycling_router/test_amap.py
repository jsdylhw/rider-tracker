from __future__ import annotations

import unittest

from integrations.route_providers.amap import AmapCyclingRouter, AmapPoint, _successful_path, parse_polyline
from integrations.route_providers.coordinates import gcj02_to_wgs84, wgs84_to_gcj02


class AmapAdapterTests(unittest.TestCase):
    def test_parse_polyline_keeps_geojson_coordinate_order(self) -> None:
        self.assertEqual(parse_polyline("118.1,32.1;118.2,32.2"), [(118.1, 32.1), (118.2, 32.2)])

    def test_rejects_unsuccessful_amap_response(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "invalid key"):
            _successful_path({"status": "0", "infocode": "10001", "info": "invalid key"})

    def test_composes_via_points_from_pairwise_bicycling_legs(self) -> None:
        class StubRouter(AmapCyclingRouter):
            def __init__(self) -> None:
                pass

            def route(self, origin: AmapPoint, destination: AmapPoint):  # type: ignore[override]
                return {
                    "provider": "amap", "profile": "bicycling", "distance_m": 100.0, "duration_s": 20.0,
                    "ascend_m": None, "geometry": [(origin.lon, origin.lat), (destination.lon, destination.lat)],
                    "instructions": [], "raw": {},
                }

        result = StubRouter().route_points((AmapPoint(32.0, 118.0), AmapPoint(32.1, 118.1), AmapPoint(32.2, 118.2)))
        self.assertEqual(result["distance_m"], 200.0)
        self.assertEqual(result["geometry"], [(118.0, 32.0), (118.1, 32.1), (118.2, 32.2)])

    def test_gcj_boundary_round_trip_is_precise_enough_for_map_rendering(self) -> None:
        wgs = (118.783439, 32.022756)
        gcj = wgs84_to_gcj02(*wgs)
        restored = gcj02_to_wgs84(*gcj)
        self.assertGreater(abs(gcj[0] - wgs[0]), 0.001)
        self.assertAlmostEqual(restored[0], wgs[0], places=6)
        self.assertAlmostEqual(restored[1], wgs[1], places=6)

    def test_router_defaults_to_two_safe_retries_for_transient_network_errors(self) -> None:
        router = AmapCyclingRouter("test-key")
        self.assertEqual(router.retries, 2)


if __name__ == "__main__":
    unittest.main()
