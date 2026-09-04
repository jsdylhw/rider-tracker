from __future__ import annotations

import json

import pytest

from demo.global_cycling_router.google_routes import GOOGLE_ROUTES_FIELD_MASK, GoogleRoutesClient, TransientProviderError, WgsPoint


def route_payload(distance=17250, duration="4020s"):
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


def test_europe_uses_bicycle_route_and_geojson():
    captured = []

    def transport(request, timeout):
        captured.append(request)
        return route_payload()

    client = GoogleRoutesClient("test-google-key", transport=transport)
    result = client.route([WgsPoint(45.899, 6.129), WgsPoint(45.84, 6.215)], country_code="FR")

    body = json.loads(captured[0].data)
    headers = {key.lower(): value for key, value in captured[0].header_items()}
    assert body["travelMode"] == "BICYCLE"
    assert "routeModifiers" not in body
    assert body["polylineEncoding"] == "GEO_JSON_LINESTRING"
    assert headers["x-goog-fieldmask"] == GOOGLE_ROUTES_FIELD_MASK
    assert result["travel_mode"] == "BICYCLE"
    assert "fallback_reason" not in result
    assert result["duration_s"] == 4020
    assert result["geometry"]["coordinates"][-1] == [135.7727, 34.9671]


def test_japan_uses_quiet_drive_fallback_for_virtual_route():
    captured = []

    def transport(request, timeout):
        captured.append(request)
        return route_payload()

    client = GoogleRoutesClient("test-google-key", transport=transport)
    result = client.route([WgsPoint(34.8908, 135.8009), WgsPoint(34.9671, 135.7727)], country_code="jp")

    body = json.loads(captured[0].data)
    assert body["travelMode"] == "DRIVE"
    assert body["routeModifiers"] == {"avoidTolls": True, "avoidHighways": True, "avoidFerries": True}
    assert result["requested_mode"] == "BICYCLE"
    assert result["travel_mode"] == "DRIVE"
    assert result["fallback_reason"] == "google_bicycle_not_supported_in_japan"
    assert "不是户外骑行导航" in result["warning"]


def test_empty_bicycle_result_retries_with_drive():
    calls = []

    def transport(request, timeout):
        body = json.loads(request.data)
        calls.append(body)
        return {} if body["travelMode"] == "BICYCLE" else route_payload()

    client = GoogleRoutesClient("test-google-key", transport=transport)
    result = client.route([WgsPoint(10, 10), WgsPoint(11, 11)])

    assert [body["travelMode"] for body in calls] == ["BICYCLE", "DRIVE"]
    assert result["fallback_reason"] == "google_bicycle_route_unavailable"


def test_route_requires_two_points():
    client = GoogleRoutesClient("test-key", transport=lambda *_: {})
    with pytest.raises(ValueError, match="at least two"):
        client.route([WgsPoint(34, 135)])


def test_route_retries_transient_transport_failure():
    calls = 0

    def transport(request, timeout):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TransientProviderError("connection reset")
        return route_payload()

    client = GoogleRoutesClient("test-key", retries=2, retry_delay_s=0, transport=transport)
    result = client.route([WgsPoint(45.899, 6.129), WgsPoint(45.84, 6.215)], country_code="FR")

    assert calls == 2
    assert result["travel_mode"] == "BICYCLE"


def test_route_does_not_retry_provider_error():
    calls = 0

    def transport(request, timeout):
        nonlocal calls
        calls += 1
        raise RuntimeError("Google Routes returned HTTP 403")

    client = GoogleRoutesClient("test-google-key", retries=2, retry_delay_s=0, transport=transport)
    with pytest.raises(RuntimeError, match="403"):
        client.route(
            [WgsPoint(48.8584, 2.2945), WgsPoint(48.8606, 2.3376)],
            country_code="FR",
        )
    assert calls == 1
