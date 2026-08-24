from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

import pytest

from agent.runtime.models import ToolExecution
from agent.runtime.presentation_projector import project_presentations
from agent.main_agent.context import AgentContext
from agent.tools.handlers.route import create_route_plan_tool, update_route_plan_tool
from services.route.single_day import compact_route_plan, create_single_day_plan, edit_candidate_waypoints
from storage.repositories.route import RoutePlanStore


def _route_result(distance_m=42_000):
    return {
        "provider": "test_provider",
        "travel_mode": "BICYCLE",
        "distance_m": distance_m,
        "duration_s": 7_200,
        "geometry": {
            "type": "LineString",
            "coordinates": [[6.1, 45.8], [6.2, 45.7]],
        },
    }


def _places(queries):
    return [
        {
            "query": query,
            "name": query,
            "address": "",
            "latitude": 45.8 - index * 0.1,
            "longitude": 6.1 + index * 0.1,
        }
        for index, query in enumerate(queries)
    ]


def test_create_loop_reuses_first_waypoint_and_compacts_geometry():
    captured = []

    def route_google(queries, country_code, route_type, config):
        captured.append(list(queries))
        return _places(queries), _route_result()

    with patch("services.route.single_day.load_config", return_value={}), patch(
        "services.route.single_day._route_google", side_effect=route_google,
    ):
        plan = create_single_day_plan(
            workspace_id="workspace",
            title="湖区环线",
            country_code="FR",
            candidates=[{
                "name": "湖区候选",
                "waypoints": ["Annecy", "Doussard", "Talloires"],
                "route_type": "loop",
                "target_distance_km": 40,
            }],
            include_elevation=False,
        )

    assert captured == [["Annecy", "Doussard", "Talloires"]]
    assert plan["candidates"][0]["waypoints"][-1]["query"] == "Annecy"
    assert plan["candidates"][0]["distance_delta_km"] == 2.0
    compact = compact_route_plan(plan)
    assert "geometry" not in compact["candidates"][0]
    assert compact["candidates"][0]["waypoints"][0]["name"] == "Annecy"


def test_create_loop_ignores_explicit_duplicate_start_at_end():
    captured = []

    def route_google(queries, country_code, route_type, config):
        captured.append(list(queries))
        return _places(queries), _route_result()

    with patch("services.route.single_day.load_config", return_value={}), patch(
        "services.route.single_day._route_google", side_effect=route_google,
    ):
        create_single_day_plan(
            workspace_id="workspace", title="重复首点", country_code="FR",
            candidates=[{
                "name": "环线", "waypoints": ["Annecy", "Talloires", " annecy "],
                "route_type": "loop",
            }],
            include_elevation=False,
        )

    assert captured == [["Annecy", "Talloires"]]


def test_route_plan_store_persists_revision_and_latest_workspace(tmp_path):
    store = RoutePlanStore(tmp_path / "routes.db")
    plan = {
        "schema_version": "route_plan.v1",
        "plan_id": "route_test",
        "workspace_id": "workspace",
        "active_candidate_id": "candidate_1",
        "candidates": [],
    }
    first = store.save(plan)
    second = store.save({**first, "title": "更新路线"})

    assert first["revision"] == 1
    assert second["revision"] == 2
    assert store.get("route_test")["title"] == "更新路线"
    assert store.get_latest("workspace")["plan_id"] == "route_test"


def test_route_plan_store_breaks_latest_timestamp_ties_by_insertion_order(tmp_path):
    store = RoutePlanStore(tmp_path / "routes.db")
    with patch("storage.repositories.route._now", return_value="2026-08-19T12:00:00+08:00"):
        store.save({"plan_id": "route_first", "workspace_id": "workspace", "candidates": []})
        store.save({"plan_id": "route_second", "workspace_id": "workspace", "candidates": []})

    assert store.get_latest("workspace")["plan_id"] == "route_second"


def test_route_plan_store_marks_an_updated_old_row_as_latest_with_same_clock_value(tmp_path):
    store = RoutePlanStore(tmp_path / "routes.db")
    timestamp = "2026-08-19T12:00:00+08:00"
    with patch("storage.repositories.route._now", return_value=timestamp):
        first = store.save({"plan_id": "route_first", "workspace_id": "workspace", "candidates": []})
        store.save({"plan_id": "route_second", "workspace_id": "workspace", "candidates": []})
        updated = store.save({**first, "title": "updated"})

    assert updated["revision"] == 2
    assert store.get_latest("workspace")["plan_id"] == "route_first"


def test_route_plan_store_serializes_concurrent_revision_updates(tmp_path):
    path = tmp_path / "routes.db"
    store = RoutePlanStore(path)
    plan = store.save({"plan_id": "route_shared", "workspace_id": "workspace", "candidates": []})
    workers = 16
    barrier = Barrier(workers)

    def save_once(index):
        barrier.wait()
        return RoutePlanStore(path).save({**plan, "writer": index})["revision"]

    with ThreadPoolExecutor(max_workers=workers) as executor:
        revisions = list(executor.map(save_once, range(workers)))

    assert sorted(revisions) == list(range(2, workers + 2))
    assert store.get("route_shared")["revision"] == workers + 1


def test_route_plan_store_undoes_multiple_persisted_edits(tmp_path):
    store = RoutePlanStore(tmp_path / "routes.db")
    first = store.save({"plan_id": "route_test", "workspace_id": "workspace", "title": "第一版", "candidates": []})
    second = store.save({**first, "title": "第二版"})
    store.save({**second, "title": "第三版"})

    undone_once = store.undo("route_test")
    undone_twice = store.undo("route_test")

    assert undone_once["title"] == "第二版"
    assert undone_once["revision"] == 4
    assert undone_twice["title"] == "第一版"
    assert undone_twice["revision"] == 5
    assert store.undo("route_test") is None
    assert store.get("route_test")["title"] == "第一版"


def test_non_edit_enrichment_does_not_consume_an_undo_step(tmp_path):
    store = RoutePlanStore(tmp_path / "routes.db")
    first = store.save({"plan_id": "route_test", "workspace_id": "workspace", "title": "第一版", "candidates": []})
    second = store.save({**first, "title": "第二版"})
    store.save({**second, "strava_segments": [101]}, archive=False)

    restored = store.undo("route_test")

    assert restored["title"] == "第一版"
    assert "strava_segments" not in restored


def test_reverse_candidate_preserves_loop_anchor_and_replaces_one_waypoint():
    captured = []
    plan = {
        "active_candidate_id": "candidate_1",
        "candidates": [{
            "candidate_id": "candidate_1",
            "name": "环线",
            "route_type": "loop",
            "waypoint_queries": ["A", "B", "C"],
            "waypoints": _places(["A", "B", "C", "A"]),
        }],
    }

    def route_google(queries, country_code, route_type, config):
        captured.append(list(queries))
        return _places(queries), _route_result()

    with patch("services.route.single_day.load_config", return_value={}), patch(
        "services.route.single_day._route_google", side_effect=route_google,
    ):
        reversed_plan = edit_candidate_waypoints(
            plan, candidate_id=None, operation="reverse", include_elevation=False,
        )
        edit_candidate_waypoints(
            reversed_plan, candidate_id=None, operation="replace_waypoint",
            waypoint_index=2, new_waypoint="D", include_elevation=False,
        )

    assert captured == [["A", "C", "B"], ["A", "D", "B"]]


def test_route_plan_presentation_loads_full_geometry(monkeypatch):
    full = {
        "plan_id": "route_test",
        "title": "测试路线",
        "active_candidate_id": "candidate_1",
        "candidates": [{
            "candidate_id": "candidate_1",
            "name": "候选一",
            "waypoints": _places(["起点", "终点"]),
            **_route_result(),
            "distance_km": 42.0,
            "duration_min": 120,
            "elevation": {
                "labels": [0, 42],
                "elevations_m": [100, 180],
            },
        }],
    }
    monkeypatch.setattr(RoutePlanStore, "get", lambda self, plan_id: full)
    execution = ToolExecution(
        index=0,
        tool="create_route_plan",
        result={"result": {"schema_version": "route_plan.v1", "plan_id": "route_test"}},
    )

    blocks = project_presentations([execution])

    assert [block.type for block in blocks] == ["table", "route_map", "line_chart"]
    assert blocks[1].data["routes"][0]["geometry"]["coordinates"][-1] == [6.2, 45.7]


def test_route_plan_presentation_combines_candidate_and_strava_pool_on_one_map(monkeypatch):
    full = {
        "plan_id": "route_test",
        "title": "测试路线",
        "active_candidate_id": "candidate_1",
        "candidates": [{
            "candidate_id": "candidate_1",
            "name": "候选一",
            "waypoints": _places(["起点", "终点"]),
            **_route_result(),
            "distance_km": 42.0,
            "duration_min": 120,
        }],
        "segment_pool": {"candidate_1": [{
            "segment_id": 101,
            "name": "湖边缓坡",
            "distance_km": 4.2,
            "geometry": {
                "type": "LineString",
                "coordinates": [[6.0, 45.5], [6.1, 45.6]],
            },
        }]},
    }
    monkeypatch.setattr(RoutePlanStore, "get", lambda self, plan_id: full)
    execution = ToolExecution(
        index=0,
        tool="create_route_plan",
        result={"result": {"schema_version": "route_plan.v1", "plan_id": "route_test"}},
    )

    blocks = project_presentations([execution])

    maps = [block for block in blocks if block.type == "route_map"]
    assert len(maps) == 1
    assert maps[0].title == "路线与 Strava 路段"
    assert [route["kind"] for route in maps[0].data["routes"]] == [
        "planned_route", "strava_segment",
    ]
    assert any(block.title == "可选 Strava 热门路段" for block in blocks)


def test_route_plan_presentation_bounds_large_geometry(monkeypatch):
    coordinates = [[float(index), float(index)] for index in range(2_000)]
    full = {
        "plan_id": "route_test",
        "active_candidate_id": "candidate_1",
        "candidates": [{
            "candidate_id": "candidate_1",
            "name": "候选一",
            "waypoints": [],
            "distance_km": 10,
            "duration_min": 30,
            "provider": "test",
            "travel_mode": "BICYCLE",
            "geometry": {"type": "LineString", "coordinates": coordinates},
        }],
    }
    monkeypatch.setattr(RoutePlanStore, "get", lambda self, plan_id: full)
    execution = ToolExecution(
        index=0,
        tool="get_route_plan",
        result={"result": {"schema_version": "route_plan.v1", "plan_id": "route_test"}},
    )

    blocks = project_presentations([execution])
    route_coordinates = next(block for block in blocks if block.type == "route_map").data["routes"][0]["geometry"]["coordinates"]
    assert len(route_coordinates) == 800
    assert route_coordinates[0] == coordinates[0]
    assert route_coordinates[-1] == coordinates[-1]


def test_create_route_plan_tool_persists_but_returns_compact_result(monkeypatch):
    plan = {
        "schema_version": "route_plan.v1",
        "plan_id": "route_test",
        "workspace_id": "workspace",
        "revision": 0,
        "title": "测试路线",
        "active_candidate_id": "candidate_1",
        "candidates": [{
            "candidate_id": "candidate_1",
            "name": "候选一",
            "route_type": "point_to_point",
            "waypoints": _places(["起点", "终点"]),
            "waypoint_queries": ["起点", "终点"],
            **_route_result(),
            "distance_km": 42.0,
            "duration_min": 120,
            "warnings": [],
        }],
    }
    monkeypatch.setattr("agent.tools.handlers.route.create_single_day_plan", lambda **kwargs: plan)
    monkeypatch.setattr(RoutePlanStore, "save", lambda self, value: {**value, "revision": 1})

    output = create_route_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={
            "title": "测试路线",
            "country_code": "FR",
            "candidates": [{"name": "候选一", "waypoints": ["起点", "终点"], "route_type": "point_to_point"}],
        },
    )

    assert output["status"] == "completed"
    assert output["result"]["revision"] == 1
    assert "geometry" not in output["result"]["candidates"][0]


def test_create_domestic_route_defers_elevation_until_segment_composition(monkeypatch):
    plan = {
        "schema_version": "route_plan.v1",
        "plan_id": "route_cn",
        "workspace_id": "workspace",
        "revision": 0,
        "title": "国内路线",
        "country_code": "CN",
        "active_candidate_id": "candidate_1",
        "candidates": [{
            "candidate_id": "candidate_1",
            "name": "候选一",
            "route_type": "point_to_point",
            "waypoints": _places(["起点", "终点"]),
            "waypoint_queries": ["起点", "终点"],
            **_route_result(),
            "distance_km": 42.0,
            "duration_min": 120,
            "warnings": [],
        }],
    }
    calls = {}

    def create(**kwargs):
        calls["baseline_include_elevation"] = kwargs["include_elevation"]
        return plan

    def enrich(value, **kwargs):
        calls["segment_strategy"] = kwargs["strategy"]
        calls["final_include_elevation"] = kwargs["include_elevation"]
        return {**value, "segment_strategy": kwargs["strategy"]}

    monkeypatch.setattr("agent.tools.handlers.route.create_single_day_plan", create)
    monkeypatch.setattr("agent.tools.handlers.route._apply_segment_strategy", enrich)
    monkeypatch.setattr(RoutePlanStore, "save", lambda self, value: {**value, "revision": 1})

    output = create_route_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={
            "title": "国内路线",
            "country_code": "CN",
            "include_elevation": True,
            "candidates": [{"name": "候选一", "waypoints": ["起点", "终点"], "route_type": "point_to_point"}],
        },
    )

    assert calls == {
        "baseline_include_elevation": False,
        "segment_strategy": "auto",
        "final_include_elevation": True,
    }
    assert output["result"]["segment_strategy"] == "auto"


def test_select_candidate_updates_latest_persisted_plan_without_rerouting(monkeypatch):
    plan = {
        "schema_version": "route_plan.v1",
        "plan_id": "route_test",
        "workspace_id": "workspace",
        "revision": 1,
        "title": "测试路线",
        "active_candidate_id": "candidate_1",
        "candidates": [
            {"candidate_id": "candidate_1", "name": "一", "distance_km": 40, "duration_min": 100},
            {"candidate_id": "candidate_2", "name": "二", "distance_km": 45, "duration_min": 110},
        ],
    }
    monkeypatch.setattr(RoutePlanStore, "get_latest", lambda self, workspace_id: plan)
    monkeypatch.setattr(RoutePlanStore, "save", lambda self, value, **kwargs: {**value, "revision": 2})

    output = update_route_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={"operation": "select_candidate", "candidate_id": "candidate_2"},
    )

    assert output["result"]["active_candidate_id"] == "candidate_2"
    assert output["result"]["revision"] == 2


def test_confirm_candidate_marks_final_selection_and_enriches_only_selected(monkeypatch):
    plan = {
        "schema_version": "route_plan.v1",
        "plan_id": "route_test",
        "workspace_id": "workspace",
        "revision": 1,
        "title": "测试路线",
        "active_candidate_id": "candidate_1",
        "planning": {"status": "awaiting_selection", "confirmed_candidate_id": None},
        "candidates": [
            {
                "candidate_id": "candidate_1", "name": "基础", "distance_m": 20_000,
                "distance_km": 20, "duration_min": 60,
                "geometry": {"type": "LineString", "coordinates": [[120, 30], [120.2, 30]]},
            },
            {
                "candidate_id": "candidate_2", "name": "热门", "distance_m": 25_000,
                "distance_km": 25, "duration_min": 75,
                "geometry": {"type": "LineString", "coordinates": [[120, 30], [120.25, 30]]},
            },
        ],
    }
    monkeypatch.setattr(RoutePlanStore, "get_latest", lambda self, workspace_id: plan)
    monkeypatch.setattr(RoutePlanStore, "save", lambda self, value, **kwargs: {**value, "revision": 2})
    monkeypatch.setattr(
        "agent.tools.handlers.route._elevation_profile",
        lambda coordinates, distance_m, config: {"summary": {"samples": 160}},
    )

    output = update_route_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={"operation": "confirm_candidate", "candidate_id": "candidate_2"},
    )

    assert output["result"]["planning"]["status"] == "confirmed"
    assert output["result"]["planning"]["confirmed_candidate_id"] == "candidate_2"
    assert output["result"]["active_candidate_id"] == "candidate_2"
    assert output["result"]["candidates"][0]["elevation_summary"] == {}
    assert output["result"]["candidates"][1]["elevation_summary"]["samples"] == 160
    assert "已确认保存" in output["answer"]


def test_update_route_plan_undo_uses_persisted_history(monkeypatch):
    plan = {
        "schema_version": "route_plan.v1",
        "plan_id": "route_test",
        "workspace_id": "workspace",
        "revision": 2,
        "title": "第二版",
        "active_candidate_id": "candidate_1",
        "candidates": [{"candidate_id": "candidate_1", "name": "路线", "distance_km": 40, "duration_min": 100}],
    }
    restored = {**plan, "revision": 3, "title": "第一版"}
    monkeypatch.setattr(RoutePlanStore, "get_latest", lambda self, workspace_id: plan)
    monkeypatch.setattr(RoutePlanStore, "undo", lambda self, plan_id: restored)

    output = update_route_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={"operation": "undo"},
    )

    assert output["result"]["revision"] == 3
    assert output["result"]["title"] == "第一版"


def test_get_or_update_rejects_plan_from_another_workspace(monkeypatch):
    monkeypatch.setattr(
        RoutePlanStore,
        "get",
        lambda self, plan_id: {"plan_id": plan_id, "workspace_id": "another-workspace"},
    )

    with pytest.raises(ValueError, match="current workspace"):
        update_route_plan_tool(
            AgentContext(session_id="session", workspace_id="workspace"),
            args={"plan_id": "route_foreign", "operation": "select_candidate", "candidate_id": "candidate_1"},
        )
