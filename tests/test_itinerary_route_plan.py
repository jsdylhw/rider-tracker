from __future__ import annotations

from unittest.mock import patch

import pytest

from agent.main_agent.context import AgentContext
from agent.runtime.models import ToolExecution
from agent.runtime.presentation_projector import project_presentations
from agent.tools.handlers.route import create_itinerary_plan_tool, update_route_plan_tool
from services.route.itinerary import create_itinerary_plan, edit_itinerary_stage_waypoints, replace_itinerary_stage
from services.route.single_day import compact_route_plan
from storage.repositories.route import RoutePlanStore


LOCATIONS = {
    "A": (30.000, 120.000),
    "B": (30.100, 120.100),
    "B-near": (30.105, 120.105),
    "C": (30.200, 120.200),
    "Far": (31.000, 121.000),
}


def _fake_route_candidate(spec, *, index, country_code, include_elevation, config):
    points = []
    for query in spec["waypoints"]:
        lat, lon = LOCATIONS[query]
        points.append({"query": query, "name": query, "latitude": lat, "longitude": lon})
    distance_km = float(spec.get("target_distance_km") or 40 + index)
    return {
        "candidate_id": spec.get("candidate_id") or f"candidate_{index}",
        "name": spec.get("name"),
        "route_type": spec.get("route_type") or "point_to_point",
        "waypoint_queries": list(spec["waypoints"]),
        "waypoints": points,
        "provider": "fake",
        "travel_mode": "BICYCLE",
        "distance_m": distance_km * 1_000,
        "distance_km": distance_km,
        "duration_s": distance_km * 180,
        "duration_min": round(distance_km * 3),
        "target_distance_km": spec.get("target_distance_km"),
        "distance_delta_km": 0,
        "geometry": {
            "type": "LineString",
            "coordinates": [[point["longitude"], point["latitude"]] for point in points],
        },
        "elevation": {
            "summary": {"ascent_m": 100},
            "labels": [0, distance_km],
            "elevations_m": [100, 120],
        } if include_elevation else None,
        "warnings": [],
    }


def _candidate(stages):
    return {"name": "主行程", "stages": stages}


def _stage(label, day, period, waypoints, target=50):
    return {
        "label": label,
        "day": day,
        "period": period,
        "waypoints": waypoints,
        "route_type": "point_to_point",
        "target_distance_km": target,
    }


def _create(schedule_type, stages, **kwargs):
    with patch("services.route.itinerary.load_config", return_value={}), patch(
        "services.route.itinerary.route_candidate", side_effect=_fake_route_candidate,
    ):
        return create_itinerary_plan(
            workspace_id="workspace",
            title="测试行程",
            country_code="CN",
            schedule_type=schedule_type,
            candidates=[_candidate(stages)],
            include_elevation=True,
            **kwargs,
        )


def test_creates_multi_day_plan_with_continuity_and_daily_summaries():
    plan = _create("multi_day", [
        _stage("第一天", 1, "full_day", ["A", "B"], 100),
        _stage("第二天", 2, "full_day", ["B-near", "C"], 80),
    ])

    candidate = plan["candidates"][0]
    assert plan["day_count"] == 2
    assert candidate["distance_km"] == 180
    assert candidate["day_summaries"] == [
        {"day": 1, "distance_km": 100.0, "duration_min": 300, "stage_count": 1},
        {"day": 2, "distance_km": 80.0, "duration_min": 240, "stage_count": 1},
    ]
    assert 0 < candidate["stages"][1]["handoff_from_previous_km"] < 1
    assert candidate["warnings"] == []


def test_creates_morning_and_afternoon_plan_for_one_day():
    plan = _create("day_parts", [
        _stage("上午", 1, "morning", ["A", "B"], 45),
        _stage("下午", 1, "afternoon", ["B", "C"], 35),
    ])

    candidate = plan["candidates"][0]
    assert plan["day_count"] == 1
    assert [item["period"] for item in candidate["stages"]] == ["morning", "afternoon"]
    assert candidate["day_summaries"][0]["stage_count"] == 2
    assert candidate["distance_km"] == 80


def test_rejects_large_stage_handoff_and_out_of_order_periods():
    with pytest.raises(ValueError, match="exceeding the 5.00 km tolerance"):
        _create("multi_day", [
            _stage("第一天", 1, "full_day", ["A", "B"]),
            _stage("第二天", 2, "full_day", ["Far", "C"]),
        ])
    with pytest.raises(ValueError, match="ordered by day and period"):
        _create("day_parts", [
            _stage("下午", 1, "afternoon", ["A", "B"]),
            _stage("上午", 1, "morning", ["B", "C"]),
        ])
    with pytest.raises(ValueError, match="consecutive and start at day 1"):
        _create("multi_day", [
            _stage("第一天", 1, "full_day", ["A", "B"]),
            _stage("第三天", 3, "full_day", ["B", "C"]),
        ])


def test_unbalanced_days_warn_and_compact_result_removes_coordinate_arrays():
    plan = _create("multi_day", [
        _stage("第一天", 1, "full_day", ["A", "B"], 100),
        _stage("第二天", 2, "full_day", ["B", "C"], 20),
    ])

    assert "每日距离差异较大" in plan["candidates"][0]["warnings"][0]
    compact = compact_route_plan(plan)
    assert compact["schedule_type"] == "multi_day"
    assert "geometry" not in compact["candidates"][0]["stages"][0]
    assert "elevations_m" not in compact["candidates"][0]["stages"][0]


def test_replaces_one_stage_and_recomputes_aggregate():
    plan = _create("day_parts", [
        _stage("上午", 1, "morning", ["A", "B"], 45),
        _stage("下午", 1, "afternoon", ["B", "C"], 35),
    ])
    stage_id = plan["candidates"][0]["stages"][1]["stage_id"]
    with patch("services.route.itinerary.load_config", return_value={}), patch(
        "services.route.itinerary.route_candidate", side_effect=_fake_route_candidate,
    ):
        updated = replace_itinerary_stage(
            plan,
            candidate_id=None,
            stage_id=stage_id,
            label="下午短线",
            waypoint_queries=["B", "C"],
            route_type="point_to_point",
            target_distance_km=20,
            include_elevation=False,
        )

    candidate = updated["candidates"][0]
    assert candidate["distance_km"] == 65
    assert candidate["stages"][1]["stage_id"] == stage_id
    assert candidate["stages"][1]["label"] == "下午短线"


def test_reverses_one_stage_from_saved_waypoints_without_model_reconstruction():
    plan = _create("day_parts", [
        _stage("上午", 1, "morning", ["A", "B"], 45),
        _stage("下午", 1, "afternoon", ["B", "C"], 35),
    ])
    plan["handoff_tolerance_km"] = 1_000
    stage_id = plan["candidates"][0]["stages"][1]["stage_id"]
    captured = []

    def route(spec, **kwargs):
        captured.append(list(spec["waypoints"]))
        return _fake_route_candidate(spec, **kwargs)

    with patch("services.route.itinerary.load_config", return_value={}), patch(
        "services.route.itinerary.route_candidate", side_effect=route,
    ):
        edit_itinerary_stage_waypoints(
            plan,
            candidate_id=None,
            stage_id=stage_id,
            operation="reverse",
            include_elevation=False,
        )

    assert captured == [["C", "B"]]


def test_itinerary_handler_persists_compact_and_presentation_expands_all_stages(monkeypatch):
    full = _create("day_parts", [
        _stage("上午", 1, "morning", ["A", "B"], 45),
        _stage("下午", 1, "afternoon", ["B", "C"], 35),
    ])
    monkeypatch.setattr("agent.tools.handlers.route.create_itinerary_plan_service", lambda **kwargs: full)
    monkeypatch.setattr(RoutePlanStore, "save", lambda self, value: {**value, "revision": 1})

    output = create_itinerary_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={
            "title": "测试行程", "country_code": "CN", "schedule_type": "day_parts",
            "segment_strategy": "ignore",
            "candidates": [{"name": "主行程", "stages": []}],
        },
    )
    assert output["result"]["day_count"] == 1
    assert "geometry" not in output["result"]["candidates"][0]["stages"][0]

    monkeypatch.setattr(RoutePlanStore, "get", lambda self, plan_id: full)
    blocks = project_presentations([
        ToolExecution(index=0, tool="create_itinerary_plan", result={"result": output["result"]}),
    ])
    assert [block.type for block in blocks] == ["table", "route_map", "line_chart", "line_chart"]
    assert len(blocks[0].data["rows"]) == 2
    assert len(blocks[1].data["routes"]) == 2


def test_update_route_plan_replaces_only_requested_itinerary_stage(monkeypatch):
    full = _create("day_parts", [
        _stage("上午", 1, "morning", ["A", "B"], 45),
        _stage("下午", 1, "afternoon", ["B", "C"], 35),
    ])
    stage_id = full["candidates"][0]["stages"][1]["stage_id"]
    monkeypatch.setattr(RoutePlanStore, "get_latest", lambda self, workspace_id: full)
    monkeypatch.setattr(RoutePlanStore, "save", lambda self, value: {**value, "revision": 2})
    monkeypatch.setattr("services.route.itinerary.load_config", lambda: {})
    monkeypatch.setattr("services.route.itinerary.route_candidate", _fake_route_candidate)

    output = update_route_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={
            "operation": "replace_stage",
            "stage_id": stage_id,
            "stage_label": "下午短线",
            "waypoints": ["B", "C"],
            "target_distance_km": 20,
            "include_elevation": False,
        },
    )

    stages = output["result"]["candidates"][0]["stages"]
    assert output["result"]["revision"] == 2
    assert [stage["distance_km"] for stage in stages] == [45, 20]
    assert stages[1]["label"] == "下午短线"
