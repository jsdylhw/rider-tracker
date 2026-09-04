from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from urllib.error import URLError

from demo.osm_cycling_router.router import Point, SEMICIRCLE_TO_DEGREES, round_trip, semicircles_to_degrees
from integrations.route_providers.strava_segments import (
    COMPATIBLE_API_BASE_URL,
    DEFAULT_API_BASE_URL,
    decode_polyline,
    explore_segments,
    segment_detail_feature,
)


class RouterHelpersTest(unittest.TestCase):
    def test_fit_semicircle_conversion(self):
        self.assertAlmostEqual(semicircles_to_degrees(1 << 30), 90.0)
        self.assertAlmostEqual(semicircles_to_degrees(-(1 << 30)), -90.0)
        self.assertAlmostEqual(SEMICIRCLE_TO_DEGREES * (1 << 31), 180.0)

    def test_graphhopper_point_query_is_lat_lon(self):
        self.assertEqual(Point(lat=31.12345678, lon=121.12345678).query_value(), "31.1234568,121.1234568")

    def test_segment_explorer_reports_tls_failure_without_disabling_verification(self):
        with patch("integrations.route_providers.strava_segments.urlopen", side_effect=URLError("TLS EOF")), \
             patch("integrations.route_providers.strava_segments.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "network/TLS"):
                explore_segments("31.0,121.0,31.1,121.1", "token", retry_attempts=2)

    def test_round_trip_uses_local_flexible_routing_parameters(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        payload = json.dumps({"paths": [{"distance": 10_000, "time": 1_000, "points": {"coordinates": []}}]}).encode()
        with patch("demo.osm_cycling_router.router.build_opener") as build:
            build.return_value.open.return_value = Response(payload)
            round_trip(Point(30.0, 121.0), distance_m=10_000, seed=4)

        request_url = build.return_value.open.call_args.args[0]
        query = parse_qs(urlsplit(request_url).query)
        self.assertEqual(query["algorithm"], ["round_trip"])
        self.assertEqual(query["ch.disable"], ["true"])
        self.assertEqual(query["round_trip.distance"], ["10000"])
        self.assertEqual(query["round_trip.seed"], ["4"])

    def test_segment_explorer_falls_back_to_compatible_hostname_after_tls_error(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        payload = json.dumps({"segments": [{"id": 1, "name": "测试路段"}]}).encode()
        with patch(
            "integrations.route_providers.strava_segments.urlopen",
            side_effect=[URLError("TLS EOF"), Response(payload)],
        ) as open_request:
            result = explore_segments("31.0,121.0,31.1,121.1", "token", retry_attempts=1)

        self.assertEqual(result["api_base_url"], COMPATIBLE_API_BASE_URL)
        self.assertEqual(result["segment_count"], 1)
        first_url = open_request.call_args_list[0].args[0].full_url
        second_url = open_request.call_args_list[1].args[0].full_url
        self.assertTrue(first_url.startswith(DEFAULT_API_BASE_URL))
        self.assertTrue(second_url.startswith(COMPATIBLE_API_BASE_URL))

    def test_segment_detail_decodes_polyline_to_planner_feature(self):
        # Google's public encoded-polyline example: (38.5,-120.2) ->
        # (40.7,-120.95) -> (43.252,-126.453).
        feature = segment_detail_feature({
            "id": 42,
            "name": "闭环样本",
            "distance": 12_300,
            "total_elevation_gain": 123,
            "map": {"polyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
        })
        self.assertEqual(feature["properties"]["kind"], "strava_segment")
        self.assertEqual(feature["properties"]["id"], 42)
        self.assertEqual(feature["geometry"]["coordinates"], [
            [-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252],
        ])


if __name__ == "__main__":
    unittest.main()
