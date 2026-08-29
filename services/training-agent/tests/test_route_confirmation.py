"""Atomic route-plan confirmation and SavedRoute transaction tests."""

from __future__ import annotations

import sqlite3

import pytest

from services.route.confirmation import confirm_and_save_route
from storage.database import initialize_database
from storage.repositories.route import RoutePlanStore
from storage.repositories.saved_route import SavedRouteStore


def test_saved_route_failure_rolls_back_confirmed_plan(tmp_path, monkeypatch):
    database = tmp_path / "route-confirmation.db"
    connection = sqlite3.connect(database)
    try:
        initialize_database(connection)
    finally:
        connection.close()
    plan_store = RoutePlanStore(database)
    plan = plan_store.save({
        "plan_id": "plan-atomic",
        "workspace_id": "workspace-1",
        "schedule_type": "single_day",
        "active_candidate_id": "candidate-1",
        "planning": {"status": "awaiting_selection"},
        "candidates": [_candidate()],
    })

    def fail_after_plan_write(self, connection, normalized):
        raise RuntimeError("simulated saved-route write failure")

    monkeypatch.setattr(SavedRouteStore, "_save_route", fail_after_plan_write)
    with pytest.raises(RuntimeError, match="simulated"):
        confirm_and_save_route(
            plan_id=plan["plan_id"],
            candidate_id="candidate-1",
            expected_revision=plan["revision"],
            workspace_id="workspace-1",
            saved_route=_saved_route(),
            database=database,
        )

    unchanged = plan_store.get(plan["plan_id"])
    assert unchanged["revision"] == plan["revision"]
    assert unchanged["planning"]["status"] == "awaiting_selection"
    assert SavedRouteStore(database).list_routes() == []


def test_confirmed_metadata_uses_stored_plan_revision(tmp_path):
    database = tmp_path / "route-metadata.db"
    connection = sqlite3.connect(database)
    try:
        initialize_database(connection)
    finally:
        connection.close()
    plan = RoutePlanStore(database).save({
        "plan_id": "plan-atomic",
        "workspace_id": "workspace-1",
        "schedule_type": "single_day",
        "active_candidate_id": "candidate-1",
        "planning": {"status": "awaiting_selection"},
        "candidates": [_candidate()],
    })
    saved_route = _saved_route()
    saved_route["metadata"] = {"planningStatus": "awaiting_selection", "revision": plan["revision"]}
    saved_route["route"]["agentMetadata"] = dict(saved_route["metadata"])

    stored_plan, stored_route = confirm_and_save_route(
        plan_id=plan["plan_id"],
        candidate_id="candidate-1",
        expected_revision=plan["revision"],
        workspace_id="workspace-1",
        saved_route=saved_route,
        database=database,
    )

    assert stored_route["metadata"]["planningStatus"] == "confirmed"
    assert stored_route["metadata"]["revision"] == stored_plan["revision"]
    assert stored_route["route"]["agentMetadata"] == stored_route["metadata"]


def _candidate() -> dict:
    return {
        "candidate_id": "candidate-1",
        "name": "Atomic route",
        "distance_m": 1000,
        "geometry": {
            "type": "LineString",
            "coordinates": [[121.0, 31.0], [121.05, 31.05], [121.1, 31.1]],
        },
    }


def _saved_route() -> dict:
    return {
        "source": "agent",
        "name": "Atomic route",
        "agentPlanId": "plan-atomic",
        "agentCandidateId": "candidate-1",
        "metadata": {},
        "route": {
            "source": "agent-planned",
            "name": "Atomic route",
            "agentPlanId": "plan-atomic",
            "agentCandidateId": "candidate-1",
            "totalDistanceMeters": 1000,
            "totalElevationGainMeters": 0,
            "hasElevationData": False,
            "mapGeometry": [
                {"lat": 31.0, "lng": 121.0},
                {"lat": 31.05, "lng": 121.05},
                {"lat": 31.1, "lng": 121.1},
            ],
            "points": [
                {"latitude": 31.0, "longitude": 121.0, "distanceMeters": 0},
                {"latitude": 31.05, "longitude": 121.05, "distanceMeters": 500},
                {"latitude": 31.1, "longitude": 121.1, "distanceMeters": 1000},
            ],
        },
    }
