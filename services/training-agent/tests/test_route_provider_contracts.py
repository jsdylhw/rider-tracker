"""Contract tests owned by the maintained route provider implementations."""

from __future__ import annotations

import io
import json
from unittest.mock import patch
from urllib.error import URLError

import pytest

from integrations.google_places import GOOGLE_PLACES_FIELD_MASK, GooglePlacesClient
from integrations.route_providers.amap import AmapCyclingRouter, AmapPoint, _successful_path, parse_polyline
from integrations.route_providers.coordinates import gcj02_to_wgs84, wgs84_to_gcj02
from integrations.route_providers.google_routes import (
    GOOGLE_ROUTES_FIELD_MASK,
    GoogleRoutesClient,
    TransientProviderError,
    WgsPoint,
)
from integrations.route_providers.strava_segments import (
    COMPATIBLE_API_BASE_URL,
    DEFAULT_API_BASE_URL,
    decode_polyline,
    explore_segments,
    segment_detail_feature,
)


def _route_payload(distance: int = 17_250, duration: str = "4020s") -> dict:
    return {
        "routes": [{
            "distanceMeters": distance,
            "duration": duration,
            "polyline": {
                "geoJsonLinestring": {
                    "type": "LineString",
                    "coordinates": [[135.8009, 34.8908], [135.79, 34.92], [135.7727, 34.9671]],
                }
            },
        }]
    }


def test_amap_contract_and_coordinate_boundary() -> None:
    assert parse_polyline("118.1,32.1;118.2,32.2") == [(118.1, 32.1), (118.2, 32.2)]
    with pytest.raises(RuntimeError, match="invalid key"):
        _successful_path({"status": "0", "infocode": "10001", "info": "invalid key"})

    class StubRouter(AmapCyclingRouter):
        def __init__(self) -> None:
            pass

        def route(self, origin: AmapPoint, destination: AmapPoint) -> dict:  # type: ignore[override]
            return {
                "provider": "amap",
                "profile": "bicycling",
                "distance_m": 100.0,
                "duration_s": 20.0,
                "ascend_m": None,
                "geometry": [(origin.lon, origin.lat), (destination.lon, destination.lat)],
                "instructions": [],
                "raw": {},
            }

    result = StubRouter().route_points(
        (AmapPoint(32.0, 118.0), AmapPoint(32.1, 118.1), AmapPoint(32.2, 118.2)),
    )
    assert result["distance_m"] == 200.0
    assert result["geometry"] == [(118.0, 32.0), (118.1, 32.1), (118.2, 32.2)]

    wgs = (118.783439, 32.022756)
    gcj = wgs84_to_gcj02(*wgs)
    restored = gcj02_to_wgs84(*gcj)
    assert abs(gcj[0] - wgs[0]) > 0.001
    assert restored == pytest.approx(wgs, abs=1e-6)


def test_google_places_route_search_contract() -> None:
    captured = {}

    def transport(request, timeout):
        captured["request"] = request
        return {
            "places": [{
                "id": "uji-station",
                "displayName": {"text": "宇治站"},
                "formattedAddress": "日本京都府宇治市",
                "location": {"latitude": 34.8908, "longitude": 135.8009},
                "types": ["train_station"],
                "addressComponents": [{"shortText": "JP", "types": ["country"]}],
            }]
        }

    result = GooglePlacesClient("test-google-key", transport=transport).search(
        "宇治站 日本", near=(34.89, 135.80), radius_m=12_000, limit=6,
    )
    body = json.loads(captured["request"].data)
    headers = {key.lower(): value for key, value in captured["request"].header_items()}
    assert body["locationBias"]["circle"]["center"] == {"latitude": 34.89, "longitude": 135.8}
    assert headers["x-goog-fieldmask"] == GOOGLE_PLACES_FIELD_MASK
    assert result["places"][0]["country_code"] == "JP"


def test_google_routes_modes_and_transient_retry() -> None:
    captured = []

    def transport(request, timeout):
        captured.append(json.loads(request.data))
        return _route_payload()

    client = GoogleRoutesClient("test-google-key", transport=transport)
    result = client.route([WgsPoint(45.899, 6.129), WgsPoint(45.84, 6.215)], country_code="FR")
    assert captured[0]["travelMode"] == "BICYCLE"
    assert result["duration_s"] == 4020

    captured.clear()
    result = client.route([WgsPoint(34.8908, 135.8009), WgsPoint(34.9671, 135.7727)], country_code="JP")
    assert captured[0]["travelMode"] == "DRIVE"
    assert result["fallback_reason"] == "google_bicycle_not_supported_in_japan"

    calls = 0

    def transient_transport(request, timeout):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TransientProviderError("connection reset")
        return _route_payload()

    result = GoogleRoutesClient(
        "test-key", retries=2, retry_delay_s=0, transport=transient_transport,
    ).route([WgsPoint(45.899, 6.129), WgsPoint(45.84, 6.215)], country_code="FR")
    assert calls == 2
    assert result["travel_mode"] == "BICYCLE"


def test_google_routes_uses_bounded_field_mask() -> None:
    captured = []

    def transport(request, timeout):
        captured.append(request)
        return _route_payload()

    GoogleRoutesClient("test-key", transport=transport).route(
        [WgsPoint(45.899, 6.129), WgsPoint(45.84, 6.215)], country_code="FR",
    )
    headers = {key.lower(): value for key, value in captured[0].header_items()}
    assert headers["x-goog-fieldmask"] == GOOGLE_ROUTES_FIELD_MASK


def test_strava_segment_provider_fallback_and_geometry_contract() -> None:
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
    assert result["api_base_url"] == COMPATIBLE_API_BASE_URL
    assert open_request.call_args_list[0].args[0].full_url.startswith(DEFAULT_API_BASE_URL)

    feature = segment_detail_feature({
        "id": 42,
        "name": "闭环样本",
        "distance": 12_300,
        "total_elevation_gain": 123,
        "map": {"polyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
    })
    assert feature["geometry"]["coordinates"] == [
        [-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252],
    ]
    assert decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")[0] == [-120.2, 38.5]
