"""Behavioral parity tests for the Python-owned Rider route library."""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from storage.database import initialize_database
from storage.repositories.saved_route import SavedRouteNotFound, SavedRouteStore


def _store(tmp_path) -> SavedRouteStore:
    path = tmp_path / "routes.db"
    connection = sqlite3.connect(path)
    try:
        initialize_database(connection)
    finally:
        connection.close()
    return SavedRouteStore(path)


def _route(source: str) -> dict:
    return {
        "source": source,
        "name": "Test route",
        "totalDistanceMeters": 1000,
        "totalElevationGainMeters": 80 if source == "gpx" else 0,
        "hasElevationData": source == "gpx",
        "points": [
            {"latitude": 31.1, "longitude": 121.1, "distanceMeters": 0, "elevationMeters": 10},
            {"latitude": 31.2, "longitude": 121.2, "distanceMeters": 1000, "elevationMeters": 90},
        ],
    }


def test_saved_routes_deduplicate_geometry_and_preserve_existing_agent_metadata(tmp_path):
    store = _store(tmp_path)
    first = store.save_route({
        "route": _route("agent-planned"),
        "source": "agent",
        "agentPlanId": "plan-1",
        "agentCandidateId": "candidate-1",
        "metadata": {"provider": "google"},
    })
    duplicate = store.save_route({
        "route": {**_route("agent-planned"), "name": "Renamed"},
        "source": "agent",
    })

    assert first["created"] is True
    assert first["id"]
    assert duplicate["created"] is False
    assert duplicate["id"] == first["id"]
    assert len(store.list_routes()) == 1
    loaded = store.get_route(first["id"])
    assert loaded["agentPlanId"] == "plan-1"
    assert loaded["metadata"] == {"provider": "google"}
    assert loaded["route"]["source"] == "agent-planned"
    assert loaded["name"] == "Renamed"
    assert loaded["route"]["name"] == "Renamed"
    assert loaded["route"]["isDraft"] is False
    assert "savedRouteId" not in loaded["route"]


def test_saved_route_fingerprint_matches_legacy_javascript_contract(tmp_path):
    store = _store(tmp_path)
    route = _route("gpx")
    route["points"][0].update({"latitude": -0.0, "longitude": 121.1})
    saved = store.save_route({"route": route, "source": "gpx"})

    # SHA-256(JSON.stringify([[Number(-0).toFixed(6), ...], ...]))
    with sqlite3.connect(store.path) as connection:
        fingerprint = connection.execute(
            "SELECT fingerprint FROM saved_routes WHERE id = ?", (saved["id"],)
        ).fetchone()[0]
    assert fingerprint == "e504326a40220e9da1a28a070d0175a9bd15450214b0f881c82aafcf8fbca80d"


def test_strava_route_is_a_supported_saved_route_source(tmp_path):
    store = _store(tmp_path)
    route = {**_route("gpx"), "source": "strava", "name": "三都经典线"}

    saved = store.save_route({
        "route": route,
        "source": "strava",
        "metadata": {"stravaRouteId": "123"},
    })

    loaded = store.get_route(saved["id"])
    assert loaded["source"] == "strava"
    assert loaded["route"]["source"] == "strava"
    assert loaded["metadata"]["stravaRouteId"] == "123"


def test_saved_route_progress_is_separate_and_cleared_near_completion(tmp_path):
    store = _store(tmp_path)
    saved = store.save_route({"route": _route("gpx"), "source": "gpx"})

    paused = store.save_progress(
        saved["id"],
        resume_distance_meters=420,
        started_at="2026-08-24T08:00:00Z",
    )
    assert paused["resumeDistanceMeters"] == 420
    assert paused["progressStatus"] == "paused"

    completed = store.save_progress(saved["id"], resume_distance_meters=995)
    assert completed["resumeDistanceMeters"] == 0
    assert completed["progressStatus"] is None


def test_geometry_update_clears_progress_beyond_corrected_route_end(tmp_path):
    store = _store(tmp_path)
    saved = store.save_route({"route": _route("gpx"), "source": "gpx"})
    store.save_progress(saved["id"], resume_distance_meters=800)

    corrected = {**_route("gpx"), "totalDistanceMeters": 700}
    replaced = store.save_route({"route": corrected, "source": "gpx"})

    assert replaced["id"] == saved["id"]
    assert replaced["resumeDistanceMeters"] == 0
    assert replaced["progressStatus"] is None


def test_saved_route_rename_delete_and_source_filter(tmp_path):
    store = _store(tmp_path)
    saved = store.save_route({"route": _route("map-drawn"), "source": "map-draw"})
    store.save_progress(saved["id"], resume_distance_meters=200)

    assert store.list_routes(source="map-drawn")[0]["id"] == saved["id"]
    assert store.rename_route(saved["id"], "New name")["name"] == "New name"
    assert store.delete_route(saved["id"])["id"] == saved["id"]
    assert store.list_routes() == []
    with pytest.raises(SavedRouteNotFound):
        store.clear_progress(saved["id"])


def test_saved_route_rejects_invalid_geometry_distance_and_source(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(ValueError, match="at least two"):
        store.save_route({"route": {"points": []}, "source": "gpx"})
    with pytest.raises(ValueError, match="usable distance"):
        store.save_route({"route": {**_route("gpx"), "totalDistanceMeters": 0}, "source": "gpx"})
    with pytest.raises(ValueError, match="Unsupported route source"):
        store.save_route({"route": _route("unknown"), "source": "unknown"})


def test_concurrent_geometry_upserts_return_one_stable_route_identity(tmp_path):
    store = _store(tmp_path)

    def save(index: int) -> dict:
        return store.save_route({
            "route": {**_route("agent-planned"), "name": f"Route {index}"},
            "source": "agent",
            "metadata": {f"writer_{index}": True},
        })

    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(save, range(6)))

    assert len({item["id"] for item in results}) == 1
    assert sum(item["created"] is True for item in results) == 1
    assert len(store.list_routes()) == 1
    assert len(store.get_route(results[0]["id"])["metadata"]) == 6
