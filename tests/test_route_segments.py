from __future__ import annotations

from agent.main_agent.context import AgentContext
from agent.runtime.models import ToolExecution
from agent.runtime.presentation_projector import project_presentations
from agent.tools.handlers.route import explore_route_segments_tool
from services.route.segments import enrich_route_plan_with_segments
from storage.repositories.route import RoutePlanStore


def _plan(*, staged: bool = False):
    route = {
        "geometry": {
            "type": "LineString",
            "coordinates": [[120.0, 30.0], [120.05, 30.05], [120.1, 30.1]],
        },
        "waypoints": [],
        "distance_km": 20,
        "duration_min": 60,
    }
    candidate = {
        "candidate_id": "candidate_1",
        "name": "主路线",
        **route,
    }
    if staged:
        candidate["stages"] = [
            {**route, "stage_id": "day_1", "label": "第一天"},
            {
                **route,
                "stage_id": "day_2",
                "label": "第二天",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[120.1, 30.1], [120.2, 30.2]],
                },
            },
        ]
    return {
        "schema_version": "route_plan.v1",
        "plan_id": "route_test",
        "workspace_id": "workspace",
        "revision": 1,
        "active_candidate_id": "candidate_1",
        "candidates": [candidate],
    }


def _explorer(bounds, token):
    assert token == "token"
    assert len(bounds.split(",")) == 4
    return {
        "segments": [
            {
                "id": 101,
                "name": "湖边缓坡",
                "distance": 3200,
                "avg_grade": 2.4,
                "elev_difference": 76,
                "climb_category_desc": "NC",
                "start_latlng": [30.01, 120.01],
                "end_latlng": [30.08, 120.08],
            },
            {
                "id": 999,
                "name": "远处路段",
                "distance": 5000,
                "start_latlng": [31.0, 121.0],
                "end_latlng": [31.1, 121.1],
            },
        ],
    }


def test_enriches_route_with_nearby_segment_and_filters_far_sample():
    updated, result = enrich_route_plan_with_segments(
        _plan(), access_token="token", corridor_km=5, explorer=_explorer,
    )

    segments = updated["candidates"][0]["strava_segments"]
    assert [item["segment_id"] for item in segments] == [101]
    assert segments[0]["average_grade_percent"] == 2.4
    assert segments[0]["geometry"]["type"] == "LineString"
    assert result["schema_version"] == "route_segment_discovery.v1"
    assert result["segment_count"] == 1
    assert "geometry" not in result["segments"][0]


def test_can_enrich_only_one_itinerary_stage():
    calls = []

    def explorer(bounds, token):
        calls.append(bounds)
        return _explorer(bounds, token)

    updated, result = enrich_route_plan_with_segments(
        _plan(staged=True), access_token="token", stage_id="day_2", explorer=explorer,
    )

    stages = updated["candidates"][0]["stages"]
    assert "strava_segments" not in stages[0]
    assert stages[1]["strava_segments"]
    assert result["stage_id"] == "day_2"
    assert len(calls) == 1


def test_agent_tool_uses_saved_route_and_persists_enrichment(monkeypatch):
    plan = _plan()
    saved = {}

    class FakeSink:
        access_token = "token"

        def explore_segments(self, bounds):
            return _explorer(bounds, self.access_token)

    monkeypatch.setattr("agent.tools.handlers.route.StravaSink", FakeSink)
    monkeypatch.setattr(RoutePlanStore, "get_latest", lambda self, workspace_id: plan)
    monkeypatch.setattr(
        RoutePlanStore,
        "save",
        lambda self, value, **kwargs: saved.update(value) or {**value, "revision": 2},
    )
    output = explore_route_segments_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={"corridor_km": 5, "max_segments": 10},
    )

    assert output["status"] == "completed"
    assert output["result"]["revision"] == 2
    assert output["result"]["segment_count"] == 1
    assert saved["candidates"][0]["strava_segments"][0]["segment_id"] == 101


def test_segment_discovery_projects_table_and_route_overlay(monkeypatch):
    enriched, result = enrich_route_plan_with_segments(
        _plan(), access_token="token", explorer=_explorer,
    )
    monkeypatch.setattr(RoutePlanStore, "get", lambda self, plan_id: enriched)
    blocks = project_presentations([
        ToolExecution(index=0, tool="explore_route_segments", result={"result": result}),
    ])

    assert [block.type for block in blocks] == ["table", "route_map"]
    assert blocks[0].data["rows"][0]["segment_name"] == "湖边缓坡"
    assert [route["kind"] for route in blocks[1].data["routes"]] == [
        "planned_route", "strava_segment",
    ]
