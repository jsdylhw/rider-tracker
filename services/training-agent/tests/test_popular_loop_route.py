from __future__ import annotations

from agent.main_agent.context import AgentContext
from agent.tools.handlers.route import create_route_plan_tool, update_route_plan_tool
from services.route.popular_loop import _rank_closed_segments, create_popular_loop_plan
from services.route.single_day import _encode_polyline
from storage.repositories.route import RoutePlanStore


def _place(query: str, key: str):
    coordinates = {
        "夫子庙": (118.79, 32.02),
        "中山陵": (118.85, 32.06),
    }
    lon, lat = coordinates[query]
    return {
        "query": query, "name": query, "address": "南京",
        "longitude": lon, "latitude": lat,
        "display_longitude": lon, "display_latitude": lat,
    }


def _explore(bounds: str):
    south, west, north, east = [float(value) for value in bounds.split(",")]
    assert south < 32.06 < north
    assert west < 118.85 < east
    return {
        "segments": [
            {
                "id": 7, "name": "普通爬坡", "distance": 3_000,
                "start_latlng": [32.00, 118.80], "end_latlng": [32.03, 118.84],
            },
            {
                "id": 12108894, "name": "环陵路一圈", "distance": 22_160,
                "start_latlng": [32.061, 118.851], "end_latlng": [32.0612, 118.8512],
                "star_count": 687,
            },
        ],
    }


def _detail(segment_id: int):
    assert segment_id == 12108894
    coordinates = [(118.851, 32.061), (118.88, 32.08), (118.8512, 32.0612)]
    return {
        "id": segment_id,
        "name": "环陵路一圈",
        "distance": 22_160,
        "total_elevation_gain": 376.3,
        "average_grade": 1.7,
        "effort_count": 43_053,
        "athlete_count": 3_121,
        "star_count": 687,
        "map": {"polyline": _encode_polyline(coordinates)},
    }


def _connector(origin, destination):
    return {
        "provider": "amap", "distance_m": 4_000, "duration_s": 900,
        "geometry": {"type": "LineString", "coordinates": [list(origin), list(destination)]},
    }


def test_popular_loop_preserves_complete_strava_geometry_and_adds_connectors():
    plan = create_popular_loop_plan(
        workspace_id="workspace",
        title="夫子庙环陵",
        origin="夫子庙",
        area="中山陵",
        segment_name_hint="环陵",
        target_distance_km=30,
        include_elevation=False,
        config={"amap": {"web_service_key": "test"}},
        place_searcher=_place,
        segment_explorer=_explore,
        segment_fetcher=_detail,
        connector_router=_connector,
    )

    candidate = plan["candidates"][0]
    assert plan["route_mode"] == "popular_loop"
    assert candidate["provider"] == "amap+strava"
    assert candidate["distance_km"] == 30.2
    assert candidate["strava_segments"][0]["segment_id"] == 12108894
    assert candidate["segment_evidence"] == {
        "strategy": "complete_popular_loop",
        "selected_segment_id": 12108894,
        "selected_segment_name": "环陵路一圈",
        "segment_distance_km": 22.2,
        "closure_gap_m": candidate["segment_evidence"]["closure_gap_m"],
        "approach_out_km": 4.0,
        "approach_back_km": 4.0,
        "search_bounds_wgs84": candidate["segment_evidence"]["search_bounds_wgs84"],
    }
    coordinates = candidate["geometry"]["coordinates"]
    assert coordinates[0] == [118.79, 32.02]
    assert [118.88, 32.08] in coordinates
    assert coordinates[-1] == [118.79, 32.02]


def test_popular_loop_accepts_descriptive_name_hint():
    plan = create_popular_loop_plan(
        workspace_id="workspace", title="夫子庙环陵", origin="夫子庙", area="中山陵",
        segment_name_hint="紫金山环陵", include_elevation=False,
        config={"amap": {"web_service_key": "test"}}, place_searcher=_place,
        segment_explorer=_explore, segment_fetcher=_detail, connector_router=_connector,
    )

    assert plan["route_mode"] == "popular_loop"
    assert plan["candidates"][0]["strava_segments"][0]["segment_id"] == 12108894


def test_foreign_popular_loop_uses_google_connector_without_changing_segment_geometry():
    def place(query: str, _key: str):
        lon, lat = ((118.79, 32.02) if query == "高松站" else (118.85, 32.06))
        return {"query": query, "name": query, "address": "Japan", "longitude": lon, "latitude": lat}

    plan = create_popular_loop_plan(
        workspace_id="workspace", title="高松热门环线", country_code="JP",
        origin="高松站", area="屋岛", segment_name_hint="环陵", include_elevation=False,
        config={"google": {"api_key": "test"}}, place_searcher=place,
        segment_explorer=_explore, segment_fetcher=_detail, connector_router=_connector,
    )

    candidate = plan["candidates"][0]
    assert plan["country_code"] == "JP"
    assert candidate["provider"] == "google_routes+strava"
    assert candidate["travel_mode"] == "DRIVE"
    assert [118.88, 32.08] in candidate["geometry"]["coordinates"]


def test_popular_loop_tries_next_candidate_when_first_detail_is_invalid():
    def explore(_bounds: str):
        return {"segments": [
            {
                "id": 1, "name": "环陵热门线", "distance": 22_000,
                "start_latlng": [32.061, 118.851], "end_latlng": [32.0611, 118.8511],
                "star_count": 1_000,
            },
            {
                "id": 12108894, "name": "环陵路一圈", "distance": 22_160,
                "start_latlng": [32.061, 118.851], "end_latlng": [32.0612, 118.8512],
                "star_count": 900,
            },
        ]}

    fetched = []

    def fetch(segment_id: int):
        fetched.append(segment_id)
        if segment_id == 1:
            return {"id": 1, "name": "环陵热门线", "distance": 22_000, "map": {}}
        return _detail(segment_id)

    plan = create_popular_loop_plan(
        workspace_id="workspace", title="夫子庙环陵", origin="夫子庙", area="中山陵",
        segment_name_hint="环陵", include_elevation=False,
        config={"amap": {"web_service_key": "test"}}, place_searcher=_place,
        segment_explorer=explore, segment_fetcher=fetch, connector_router=_connector,
    )

    assert fetched == [1, 12108894]
    assert plan["route_mode"] == "popular_loop"
    assert plan["candidates"][0]["strava_segments"][0]["segment_id"] == 12108894


def test_popular_loop_target_distance_accounts_for_connectors():
    def explore(_bounds: str):
        return {"segments": [
            {
                "id": 22, "name": "湖区环线甲", "distance": 22_000,
                "start_latlng": [32.061, 118.851], "end_latlng": [32.0611, 118.8511],
                "star_count": 100,
            },
            {
                "id": 30, "name": "湖区环线乙", "distance": 30_000,
                "start_latlng": [32.061, 118.851], "end_latlng": [32.0611, 118.8511],
                "star_count": 200,
            },
        ]}

    fetched = []

    def fetch(segment_id: int):
        fetched.append(segment_id)
        detail = _detail(12108894)
        return {**detail, "id": segment_id, "name": f"湖区环线{segment_id}", "distance": segment_id * 1_000}

    plan = create_popular_loop_plan(
        workspace_id="workspace", title="夫子庙湖区环线", origin="夫子庙", area="中山陵",
        target_distance_km=30, include_elevation=False,
        config={"amap": {"web_service_key": "test"}}, place_searcher=_place,
        segment_explorer=explore, segment_fetcher=fetch, connector_router=_connector,
    )

    assert fetched == [22, 30]
    assert len(plan["candidates"]) == 2
    assert plan["candidates"][0]["strava_segments"][0]["segment_id"] == 22


def test_short_open_climb_is_not_treated_as_a_closed_loop():
    try:
        _rank_closed_segments(
            [{
                "id": 1,
                "name": "紫金山短爬坡",
                "distance": 1_340,
                "start_latlng": [32.061, 118.851],
                "end_latlng": [32.067, 118.858],
            }],
            name_hint="紫金山环陵",
            target_distance_km=30,
            origin=[118.79, 32.02],
        )
    except ValueError as exc:
        assert "没有返回闭合" in str(exc)
    else:
        raise AssertionError("a route with a closure gap near its own length is not a loop")


def test_popular_loop_tool_persists_compact_result(monkeypatch):
    plan = create_popular_loop_plan(
        workspace_id="workspace", title="夫子庙环陵", origin="夫子庙", area="中山陵",
        segment_name_hint="环陵", include_elevation=False,
        config={"amap": {"web_service_key": "test"}}, place_searcher=_place,
        segment_explorer=_explore, segment_fetcher=_detail, connector_router=_connector,
    )
    monkeypatch.setattr("agent.tools.handlers.route.create_popular_loop_plan", lambda **kwargs: plan)
    monkeypatch.setattr(RoutePlanStore, "save", lambda self, value: {**value, "revision": 1})

    output = create_route_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={
            "title": "夫子庙环陵", "country_code": "CN", "segment_strategy": "complete_loop",
            "origin": "夫子庙", "area": "中山陵",
        },
    )

    assert output["status"] == "completed"
    assert output["result"]["route_mode"] == "popular_loop"
    assert output["result"]["candidates"][0]["strava_segments"][0]["segment_id"] == 12108894
    assert "geometry" not in output["result"]["candidates"][0]


def test_popular_loop_explicitly_marks_provider_fallback(monkeypatch):
    fallback = {
        "schema_version": "route_plan.v1", "plan_id": "fallback", "workspace_id": "workspace",
        "country_code": "CN", "active_candidate_id": "candidate_1",
        "candidates": [{"candidate_id": "candidate_1", "warnings": []}],
    }
    monkeypatch.setattr("services.route.popular_loop.create_single_day_plan", lambda **kwargs: fallback)

    plan = create_popular_loop_plan(
        workspace_id="workspace", title="夫子庙环陵", origin="夫子庙", area="中山陵",
        segment_name_hint="不存在的环线", include_elevation=False,
        config={"amap": {"web_service_key": "test"}}, place_searcher=_place,
        segment_explorer=_explore, segment_fetcher=_detail, connector_router=_connector,
    )

    assert plan["route_mode"] == "popular_loop_fallback"
    assert plan["popular_loop_error"]["type"] == "ValueError"
    assert "已降级" in plan["candidates"][0]["warnings"][-1]


def test_reverse_popular_loop_keeps_strava_route_instead_of_generic_reroute(monkeypatch):
    plan = create_popular_loop_plan(
        workspace_id="workspace", title="夫子庙环陵", origin="夫子庙", area="中山陵",
        segment_name_hint="环陵", include_elevation=False,
        config={"amap": {"web_service_key": "test"}}, place_searcher=_place,
        segment_explorer=_explore, segment_fetcher=_detail, connector_router=_connector,
    )
    original = list(plan["candidates"][0]["geometry"]["coordinates"])
    monkeypatch.setattr(RoutePlanStore, "get_latest", lambda self, workspace_id: plan)
    monkeypatch.setattr(RoutePlanStore, "save", lambda self, value, **kwargs: {**value, "revision": 2})

    output = update_route_plan_tool(
        AgentContext(session_id="session", workspace_id="workspace"),
        args={"operation": "reverse_candidate"},
    )

    assert output["result"]["route_mode"] == "popular_loop"
    assert plan["candidates"][0]["geometry"]["coordinates"] == original
    # The saved full object passed to compacting is reversed; compact evidence
    # still proves that the same complete Segment remains selected.
    assert output["result"]["candidates"][0]["segment_evidence"]["selected_segment_id"] == 12108894
    assert output["result"]["candidates"][0]["strava_segments"][0]["route_direction"] == "reverse"


def test_popular_loop_rejects_generic_waypoint_edit(monkeypatch):
    plan = create_popular_loop_plan(
        workspace_id="workspace", title="夫子庙环陵", origin="夫子庙", area="中山陵",
        segment_name_hint="环陵", include_elevation=False,
        config={"amap": {"web_service_key": "test"}}, place_searcher=_place,
        segment_explorer=_explore, segment_fetcher=_detail, connector_router=_connector,
    )
    monkeypatch.setattr(RoutePlanStore, "get_latest", lambda self, workspace_id: plan)

    try:
        update_route_plan_tool(
            AgentContext(session_id="session", workspace_id="workspace"),
            args={"operation": "replace_waypoint", "waypoint_index": 2, "new_waypoint": "玄武湖"},
        )
    except ValueError as exc:
        assert "create_route_plan" in str(exc)
    else:
        raise AssertionError("generic edits must not erase the selected complete Strava loop")
