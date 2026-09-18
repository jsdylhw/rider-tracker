from copy import deepcopy
from unittest.mock import Mock

import pytest

from services.route.materials import validate_materials
from services.route.preparation import prepare_route_materials, rank_skeletons, discover_optional_segments


def materials():
    return {"schema_version": "route_materials.v1", "country_code": "JP", "origin_id": "a",
            "is_loop": True, "target_distance_km": 30,
            "points": [{"id": pid, "query": f"Kyoto {pid}", "required": pid in "ab",
                        "source_ids": []} for pid in "abcd"],
            "corridors": [{"id": "river", "name": "河东岸向北", "point_ids": ["b", "c"],
                           "required": True, "source_ids": []}]}


@pytest.mark.parametrize("return_id", ["return", "a"])
def test_loop_alias_and_closure_are_normalized_without_mutating_input(return_id):
    value = materials()
    value.pop("schema_version")
    value["points"].append({**value["points"][0], "id": return_id})
    value["corridors"][0]["point_ids"] = ["a", "b", "c", return_id]
    original = deepcopy(value)
    result = validate_materials(value)
    assert value == original
    assert result["schema_version"] == "route_materials.v1"
    assert len(result["points"]) == 4
    assert result["corridors"][0]["point_ids"] == ["a", "b", "c"]
    assert rank_skeletons(result, resolved(result))


def test_internal_revisit_is_not_silently_deleted():
    value = materials()
    value["corridors"][0]["point_ids"] = ["b", "c", "b", "d"]
    with pytest.raises(ValueError, match="中间重复"):
        validate_materials(value)


def test_locality_rejects_neighbor_and_missing_city_evidence():
    from services.route.preparation import check_locality
    check_locality({"localities": ["京都市"]}, "京都市")
    for localities in (["亀岡市"], [], ["京都府"]):
        with pytest.raises(ValueError, match="不符合"):
            check_locality({"localities": localities}, "京都市")


def test_google_city_evidence_does_not_use_prefecture():
    from integrations.google_places import _normalize_route_place
    place = _normalize_route_place({"id": "test", "location": {"latitude": 35, "longitude": 135},
        "addressComponents": [
            {"types": ["administrative_area_level_1"], "longText": "京都府"},
            {"types": ["locality"], "longText": "亀岡市", "shortText": "亀岡市"},
        ]})
    assert place["localities"] == ["亀岡市"]


def test_city_translation_uses_provider_city_evidence(monkeypatch):
    from services.route import preparation
    city = {"id": "kyoto-city", "country_code": "JP", "types": ["locality", "political"],
            "name": "Kyoto", "localities": ["Kyoto"]}
    client = Mock()
    client.search.return_value = {"places": [city]}
    monkeypatch.setattr(preparation, "GooglePlacesClient", lambda key: client)
    evidence = preparation.resolve_google_locality("京都市", "JP", {"google": {"api_key": "test"}})
    assert evidence["place_id"] == "kyoto-city"
    preparation.check_locality({"localities": ["Kyoto"], "country_code": "JP"}, "京都市", evidence=evidence)
    for names, country in [(["Kameoka"], "JP"), (["Kyoto Prefecture"], "JP"), ([], "JP"), (["Kyoto"], "US")]:
        with pytest.raises(ValueError):
            preparation.check_locality({"localities": names, "country_code": country}, "京都市", evidence=evidence)
    for results in ([{**city, "types": ["administrative_area_level_1"]}], [city, {**city, "id": "other-city"}], []):
        client.search.return_value = {"places": results}
        with pytest.raises(ValueError, match="唯一"):
            preparation.resolve_google_locality("京都市", "JP", {"google": {"api_key": "test"}})


def test_translated_alias_requires_same_city_place_id(monkeypatch):
    from services.route import preparation
    city = {"id": "city", "country_code": "JP", "types": ["locality"], "localities": ["京都市"]}
    client = Mock()
    monkeypatch.setattr(preparation, "GooglePlacesClient", lambda key: client)
    for city_id, accepted in [("city", True), ("different", False)]:
        client.search.side_effect = [{"places": [city]}, {"places": [{**city, "id": city_id, "localities": ["Kyoto"]}]}]
        evidence = preparation.resolve_google_locality("京都市", "JP", {"google": {"api_key": "test"}})
        assert ("Kyoto" in evidence["names"]) is accepted


def test_create_without_preparation_is_blocked_before_handler(monkeypatch):
    from agent.route import agent
    from agent.route.contracts import RouteTaskInput
    create = Mock()
    monkeypatch.setitem(agent.TOOL_HANDLERS, "create_route_plan", create)
    class Client:
        calls = 0
        def create_messages(self, **kwargs):
            self.calls += 1
            name, args = ("create_route_plan", {"use_prepared_candidates": True}) if self.calls == 1 else (
                "request_route_clarification", {"question": "需要先明确城市？"})
            return {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": str(self.calls), "name": name, "input": args}]}
    result, _ = agent.run_route_agent(RouteTaskInput(message="规划", workspace_id="test", request_id="guard"), client=Client())
    create.assert_not_called()
    assert result["status"] == "clarification_required"


def test_material_corrections_do_not_spend_provider_budget(monkeypatch):
    from agent.route import agent
    from agent.route.contracts import RouteTaskInput
    from services.route.materials import MaterialInputError
    calls = []
    def prepare(args, context):
        calls.append(args)
        if len(calls) < 3:
            raise MaterialInputError("$.points: 修正地点")
        return {"status": "prepared"}
    monkeypatch.setitem(agent.TOOL_HANDLERS, "prepare_route_materials", prepare)
    class Client:
        def create_messages(self, **kwargs):
            name, args = ("prepare_route_materials", {"materials": materials()}) if len(calls) < 3 else (
                "request_route_clarification", {"question": "从哪个入口开始？"})
            return {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": str(len(calls)), "name": name, "input": args}]}
    result, _ = agent.run_route_agent(RouteTaskInput(message="京都", workspace_id="test", request_id="budget"), client=Client())
    assert len(calls) == 3
    assert result["status"] == "clarification_required"


def test_provider_exhaustion_preserves_network_failure(monkeypatch):
    from agent.route import agent
    from agent.route.contracts import RouteTaskInput
    from integrations.provider_error import TransientProviderError
    prepare = Mock(side_effect=TransientProviderError("TLS EOF", provider="google_places", code="connection_failed"))
    monkeypatch.setitem(agent.TOOL_HANDLERS, "prepare_route_materials", prepare)
    class Client:
        def create_messages(self, **kwargs):
            return {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "p",
                "name": "prepare_route_materials", "input": {"materials": materials()}}]}
    result, _ = agent.run_route_agent(RouteTaskInput(message="京都", workspace_id="test", request_id="network"), client=Client())
    assert prepare.call_count == 2
    assert result["error"]["code"] == "connection_failed"
    assert "TLS EOF" in result["answer"]
    assert not result.get("route_plan")


def resolved(value, **kwargs):
    return {p["id"]: {**p, "coordinate": [135.7 + i * .01, 35 + i * .005],
                      "place": {"query": p["query"], "latitude": 35+i*.005, "longitude": 135.7+i*.01}}
            for i, p in enumerate(value["points"])}


@pytest.mark.parametrize("change", [
    lambda m: m["points"][0].update(latitude=35),
    lambda m: m["points"][0].update(source_ids=["invented"]),
    lambda m: m["corridors"][0].update(point_ids=["b", "unknown"]),
    lambda m: m.update(target_distance_km=float("nan")),
    lambda m: m.update(is_loop=False),
    lambda m: m["points"][1].update(id="a"),
])
def test_material_semantic_validation(change):
    value = materials()
    change(value)
    with pytest.raises(ValueError):
        validate_materials(value)


def test_preparation_without_strava_preserves_required_corridor_and_target():
    unavailable = Mock(return_value=([], {"status": "unavailable", "message": "未连接"}))
    original = materials()
    result = prepare_route_materials(original, config={}, resolver=resolved, discoverer=unavailable)
    assert result["status"] == "prepared" and "route_plan" not in result
    assert result["materials"]["target_distance_km"] == 30
    assert result["strava"]["status"] == "unavailable"
    assert original == materials()
    for skeleton in result["skeletons"]:
        ids = skeleton["point_ids"]
        assert ids[0] == ids[-1] == "a"
        assert ids[ids.index("b")+1] == "c"
        assert skeleton["validation_status"] == "pending"
        assert "distance_m" not in skeleton


def test_mixed_skeletons_keep_point_fallback_and_segment_direction():
    value = materials()
    points = resolved(value)
    segment = {"segment_id": 12, "distance_m": 1500,
               "geometry": {"type": "LineString", "coordinates": [[135.73, 35.02], [135.74, 35.03]]}}
    snapshot = deepcopy(segment)
    candidates = rank_skeletons(value, points, [segment])
    mixed = [s for s in candidates if any(l["kind"] == "segment" for l in s["legs"])]
    assert 1 <= len(mixed) <= 3 and len(candidates) <= 6
    assert len(candidates) > len(mixed)
    assert segment == snapshot
    for skeleton in mixed:
        legs = skeleton["legs"]
        i = next(i for i, leg in enumerate(legs) if leg["kind"] == "segment")
        assert legs[i]["direction"] == "forward"
        assert legs[i-1]["to"] == segment["geometry"]["coordinates"][0]
        assert legs[i+1]["from"] == segment["geometry"]["coordinates"][-1]


def test_strava_disabled_or_disconnected_never_blocks():
    factory = Mock(side_effect=RuntimeError("secret-token"))
    pool, status = discover_optional_segments([135, 35], radius_km=10, config={}, enabled=False, sink_factory=factory)
    factory.assert_not_called()
    assert status["status"] == "disabled"
    pool, status = discover_optional_segments([135, 35], radius_km=10, config={}, sink_factory=factory)
    assert pool == [] and status["stage"] == "connection"
    assert "secret-token" not in str(status)


def test_strava_partial_detail_failure_and_budget(monkeypatch):
    import services.route.preparation as module
    sink = Mock()
    sink.explore_segments.return_value = {"segments": [{"id": i} for i in range(1, 30)]}
    sink.get_segment.side_effect = lambda i: {"id": i}
    def feature(detail):
        if detail["id"] == 2:
            raise ValueError("bad detail")
        return {"properties": {"id": detail["id"], "name": "route"},
                "geometry": {"type": "LineString", "coordinates": [[135, 35], [135.01, 35.01]]}}
    monkeypatch.setattr(module, "segment_detail_feature", feature)
    pool, status = discover_optional_segments([135, 35], radius_km=10, config={}, sink_factory=lambda cfg: sink)
    assert len(pool) == 9 and sink.get_segment.call_count == 10
    assert status["status"] == "partial"
    sink.reset_mock()
    ticks = iter([0, 1, 21])
    pool, status = discover_optional_segments([135, 35], radius_km=10, config={},
                                             sink_factory=lambda cfg: sink, clock=lambda: next(ticks))
    sink.get_segment.assert_not_called()
    assert status["failures"][0]["code"] == "budget_exhausted"


def test_prepared_google_places_are_used_without_place_search(monkeypatch):
    from services.route import single_day as module
    places = [{"query": "A", "latitude": 35, "longitude": 135},
              {"query": "B", "latitude": 35.01, "longitude": 135.01}]
    search = Mock(side_effect=AssertionError("must reuse resolved coordinates"))
    monkeypatch.setattr(module, "GooglePlacesClient", search)
    router = Mock()
    router.route.return_value = {"distance_m": 3000}
    monkeypatch.setattr(module, "GoogleRoutesClient", lambda key: router)
    returned, route = module._route_google(["A", "B"], "JP", True,
                                          {"google": {"api_key": "test"}}, resolved_places=places)
    search.assert_not_called()
    points = router.route.call_args.args[0]
    assert points[0] == points[-1]
    assert len(points) == 3 and returned == places


def test_material_resolution_caches_origin_and_never_routes(monkeypatch):
    from services.route.preparation import resolve_material_points
    from services.route import single_day
    client = Mock()
    client.search.side_effect = lambda query, **kw: {"places": [{
        "id": query, "name": query, "country_code": "JP",
        "location": {"latitude": 35.0, "longitude": 135.7},
    }]}
    monkeypatch.setattr(single_day, "GooglePlacesClient", lambda key: client)
    router = Mock(side_effect=AssertionError("preparation must not route"))
    monkeypatch.setattr(single_day, "GoogleRoutesClient", router)
    points = resolve_material_points(materials(), config={"google": {"api_key": "test"}})
    assert client.search.call_count == 4
    assert all(p["place"]["place_id"] == p["query"] for p in points.values())
    router.assert_not_called()


def test_domestic_resolution_retains_native_and_wgs_coordinates(monkeypatch):
    from services.route import preparation
    value = materials()
    value["country_code"] = "CN"
    monkeypatch.setattr(preparation, "_search_amap_place", lambda query, key, **kw: {
        "query": query, "latitude": 31.23, "longitude": 121.48,
        "display_latitude": 31.232, "display_longitude": 121.475, "place_id": query,
    })
    points = preparation.resolve_material_points(value, config={"amap": {"web_service_key": "test"}})
    assert points["a"]["coordinate"] == [121.475, 31.232]
    assert points["a"]["place"]["longitude"] == 121.48


def test_preparation_failure_invalidates_previous_context(monkeypatch):
    from agent.main_agent.context import AgentContext
    from agent.tools.handlers.route import prepare_route_materials_tool
    import services.route.preparation as module
    context = AgentContext(session_id="test")
    context.route_preparation = {"old": True}
    monkeypatch.setattr(module, "prepare_route_materials", Mock(side_effect=ValueError("invalid")))
    with pytest.raises(ValueError):
        prepare_route_materials_tool({"materials": {}}, context)
    assert context.route_preparation is None


def test_prepare_only_agent_turn_is_not_route_success(monkeypatch):
    from agent.route import agent
    from agent.route.contracts import RouteTaskInput
    prepare = Mock(return_value={"status": "prepared", "notice": "待验证"})
    monkeypatch.setitem(agent.TOOL_HANDLERS, "prepare_route_materials", prepare)
    class Client:
        def create_messages(self, **kwargs):
            return {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "p",
                    "name": "prepare_route_materials", "input": {"materials": materials()}}]}
    result, _ = agent.run_route_agent(RouteTaskInput(message="京都30km", workspace_id="test", request_id="prep"), client=Client())
    assert prepare.call_count == 2
    assert result["route_task"]["status"] == "failed"
    assert not result.get("route_plan")


def test_prepared_creation_reuses_coordinates_and_never_repeats_strava(monkeypatch, tmp_path):
    from agent.main_agent.context import AgentContext
    from agent.tools.handlers import route as handler
    from services.route import single_day
    from storage.repositories.route import RoutePlanStore
    prepared = prepare_route_materials(materials(), config={}, resolver=resolved,
        discoverer=lambda *a, **kw: ([], {"status": "unavailable", "message": "未连接 Strava，继续规划。"}))
    context = AgentContext(session_id="test", workspace_id="test", route_request_options={"include_elevation": False})
    context.route_preparation = prepared
    store = RoutePlanStore(tmp_path / "routes.db")
    monkeypatch.setattr(handler, "RoutePlanStore", lambda: store)
    monkeypatch.setattr(handler, "_apply_segment_strategy", Mock(side_effect=AssertionError("must not repeat discovery")))
    monkeypatch.setattr(single_day, "load_config", lambda: {"google": {"api_key": "test"}})
    monkeypatch.setattr(single_day, "ensure_google_route_provider_ready", lambda c: None)
    monkeypatch.setattr(single_day, "GooglePlacesClient", Mock(side_effect=AssertionError("must not resolve again")))
    router = Mock()
    router.route.side_effect = lambda points, **kw: {
        "provider": "test", "distance_m": 30000, "duration_s": 3600,
        "geometry": {"type": "LineString", "coordinates": [[p.lon, p.lat] for p in points]},
    }
    monkeypatch.setattr(single_day, "GoogleRoutesClient", lambda key: router)
    result = handler.create_route_plan_tool(context, args={"title": "测试", "country_code": "FR",
                                                          "target_distance_km": 1, "use_prepared_candidates": True})
    stored = store.get(result["result"]["plan_id"])
    assert stored["country_code"] == "JP"
    assert stored["route_preparation"]["status"] == "prepared"
    assert all(c["target_distance_km"] == 30 for c in stored["candidates"])
    assert all("未连接 Strava" in str(c["warnings"]) for c in stored["candidates"])


def test_prepare_then_create_in_same_round_is_blocked(monkeypatch):
    from agent.route import agent
    from agent.route.contracts import RouteTaskInput
    monkeypatch.setitem(agent.TOOL_HANDLERS, "prepare_route_materials", lambda *a: {"status": "prepared"})
    create = Mock()
    monkeypatch.setitem(agent.TOOL_HANDLERS, "create_route_plan", create)
    class Client:
        calls = 0
        def create_messages(self, **kwargs):
            self.calls += 1
            blocks = [("prepare_route_materials", {"materials": materials()}), ("create_route_plan", {})] if self.calls == 1 else [
                ("request_route_clarification", {"question": "调整地点？"})]
            return {"stop_reason": "tool_use", "content": [
                {"type": "tool_use", "id": str(i), "name": name, "input": args}
                for i, (name, args) in enumerate(blocks)]}
    result, _ = agent.run_route_agent(RouteTaskInput(message="京都", workspace_id="test", request_id="prep"), client=Client())
    create.assert_not_called()
    assert result["status"] == "clarification_required"


@pytest.mark.parametrize('outcome', ['success', 'provider_failure', 'uncorrected'])
def test_corrected_corridor_does_not_poison_final_result(monkeypatch, tmp_path, outcome):
    from agent.route import agent
    from agent.route.contracts import RouteTaskInput
    from agent.main_agent import result_builder
    monkeypatch.setenv('RIDER_LOG_DIR', str(tmp_path))
    plan = {'plan_id': 'plan', 'workspace_id': 'test', 'revision': 1}
    monkeypatch.setattr(result_builder, 'RoutePlanStore', lambda: Mock(get=lambda _: plan))
    monkeypatch.setattr(result_builder, 'build_route_plan_view', lambda p: p)
    bad = materials()
    bad['corridors'][0]['point_ids'] = ['b']
    def prepare(args, context):
        context.route_preparation = None
        value = validate_materials(args['materials'])
        context.route_preparation = {'status': 'prepared', 'materials': value}
        return context.route_preparation
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'prepare_route_materials', prepare)
    create = Mock(return_value=({'status': 'failed', 'error': 'offline', 'code': 'provider_connection_failed'}
                  if outcome == 'provider_failure' else {'status': 'completed', 'result': {'plan_id': 'plan'}}))
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'create_route_plan', create)
    class Client:
        n = 0
        def create_messages(self, **kwargs):
            self.n += 1
            if self.n < 3 or outcome == 'uncorrected':
                name = 'prepare_route_materials'
                args = {'materials': bad if self.n == 1 or outcome == 'uncorrected' else materials()}
            else:
                name, args = 'create_route_plan', {'use_prepared_candidates': True}
            return {'stop_reason': 'tool_use', 'content': [{'type': 'tool_use', 'id': str(self.n), 'name': name, 'input': args}]}
    result, _ = agent.run_route_agent(RouteTaskInput(message='京都30km', workspace_id='test', request_id='recovery'), client=Client())
    if outcome == 'success':
        assert result['status'] == 'completed'
        assert result['route_plan']['plan_id'] == 'plan'
        assert result['executions'][0]['status'] == 'recovered'
    else:
        assert not result.get('route_plan')
        assert result['error']['code'] == ('route_materials_invalid' if outcome == 'uncorrected' else 'provider_connection_failed')
    assert create.call_count == (0 if outcome == 'uncorrected' else 1)
