from __future__ import annotations

import json
import threading
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

import pytest

from demo.global_cycling_router.google_routes import WgsPoint
from demo.global_cycling_router.web_server import create_server, parse_wgs_point


class FakePlaces:
    def __init__(self):
        self.calls = []

    def search(self, query, **kwargs):
        self.calls.append((query, kwargs))
        return {
            "schema_version": "place_search.v1",
            "provider": "google_places",
            "coordinate_system": "wgs84",
            "query": query,
            "places": [{
                "id": "uji",
                "name": "宇治站",
                "address": "Kyoto, Japan",
                "location": {"latitude": 34.8908, "longitude": 135.8009},
                "types": ["train_station"],
                "country_code": "JP",
            }],
        }


class FakeRouter:
    def __init__(self):
        self.calls = []

    def route(self, points, **kwargs):
        self.calls.append((points, kwargs))
        return {
            "schema_version": "cycling_route.v1",
            "provider": "google_routes",
            "requested_mode": "BICYCLE",
            "travel_mode": "DRIVE",
            "coordinate_system": "wgs84",
            "distance_m": 1000,
            "duration_s": 300,
            "geometry": {"type": "LineString", "coordinates": [[135.8, 34.89], [135.81, 34.90]]},
            "instructions": [],
        }


@pytest.fixture
def running_server(tmp_path):
    (tmp_path / "index.html").write_text("demo", encoding="utf-8")
    places = FakePlaces()
    router = FakeRouter()
    server = create_server(host="127.0.0.1", port=0, static_dir=tmp_path, places=places, router=router)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", places, router
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def get_json(url):
    with build_opener(ProxyHandler({})).open(url, timeout=2) as response:
        return response.status, json.load(response)


def test_health_and_place_search(running_server):
    base_url, places, _ = running_server
    status, health = get_json(f"{base_url}/health")
    assert status == 200
    assert health["place_provider"] == "google_places"

    status, result = get_json(f"{base_url}/api/places?q=%E5%AE%87%E6%B2%BB%E7%AB%99&limit=6")
    assert status == 200
    assert result["places"][0]["name"] == "宇治站"
    assert places.calls == [("宇治站", {"near": None, "radius_m": 20000, "language_code": "zh-CN", "limit": 6})]


def test_route_accepts_repeated_wgs_points(running_server):
    base_url, _, router = running_server
    status, result = get_json(f"{base_url}/api/route?point=34.8908,135.8009&point=34.9671,135.7727&country=JP")
    assert status == 200
    assert result["provider"] == "google_routes"
    assert router.calls == [([WgsPoint(34.8908, 135.8009), WgsPoint(34.9671, 135.7727)], {"country_code": "JP"})]


def test_bad_route_input_returns_400_without_provider_call(running_server):
    base_url, _, router = running_server
    with pytest.raises(HTTPError) as captured:
        build_opener(ProxyHandler({})).open(f"{base_url}/api/route?point=not-a-point", timeout=2)
    assert captured.value.code == 400
    payload = json.load(captured.value)
    assert "latitude,longitude" in payload["error"]
    assert router.calls == []


def test_parse_wgs_point_rejects_out_of_range():
    with pytest.raises(ValueError, match="outside"):
        parse_wgs_point("91,10")
