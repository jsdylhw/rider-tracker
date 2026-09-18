"""Dialogue regressions: scripted model + map replies, real Agent/Tool/Service/store."""
from copy import deepcopy
import pytest

from agent.route.agent import run_route_agent
from agent.route.contracts import RouteTaskInput
from integrations.provider_error import TransientProviderError
from services.route import single_day
from storage.repositories.route import RoutePlanStore


class ScriptedModel:
    def __init__(self, name, arguments):
        self.name, self.arguments = name, arguments
        self.calls = []

    def create_messages(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        return {"stop_reason": "tool_use", "content": [{
            "type": "tool_use", "id": "route-call", "name": self.name, "input": self.arguments,
        }]}


@pytest.fixture
def map_replies(monkeypatch):
    replies = {"鸭川": 11100, "东山": 29800, "岚山": "gateway"}
    observed = []
    def route(queries, country_code, is_closed, config, **kwargs):
        observed.append((list(queries), kwargs.get("target_distance_km")))
        value = replies[queries[1]]
        if value == "gateway":
            raise TransientProviderError("Google Places HTTP 400：代理或上游网关返回了非 JSON 响应",
                                         provider="google_places", stage="place_search")
        places = [{"query": q, "name": q, "latitude": 35 + i * .01, "longitude": 135.7 + i * .01}
                  for i, q in enumerate(queries)]
        return places, {"provider": "google", "travel_mode": "BICYCLE", "distance_m": value,
                        "duration_s": value / 7, "geometry": {"type": "LineString",
                        "coordinates": [[135.7, 35], [135.71, 35.01], [135.7, 35]]}}
    monkeypatch.setattr(single_day, "_route_google", route)
    monkeypatch.setattr(single_day, "load_config", lambda: {})
    monkeypatch.setattr(single_day, "ensure_google_route_provider_ready", lambda _: None)
    return replies, observed


def create_arguments():
    return {"title": "京都风景环线", "country_code": "JP", "target_distance_km": 30,
            "include_elevation": False, "segment_strategy": "ignore", "candidates": [
                {"name": "鸭川河畔环线", "waypoints": ["京都站", "鸭川", "京都站"], "target_distance_km": 11.1},
                {"name": "东山风景环线", "waypoints": ["京都站", "东山", "京都站"]},
                {"name": "岚山—桂川环线", "waypoints": ["京都站", "岚山", "京都站"]},
            ]}


def turn(message, tool, args, *, number, reference=None, history=None):
    reference = reference or {}
    model = ScriptedModel(tool, args)
    result, dialogue = run_route_agent(RouteTaskInput(
        message=message, workspace_id="dialogue", request_id=f"turn-{number}",
        action="refine" if reference else "create", plan_id=reference.get("plan_id"),
        revision=reference.get("revision"), options={"include_elevation": False},
    ), history=history, client=model)
    assert len(model.calls) == 1
    assert any(m.get("content") == message for m in model.calls[0]["messages"])
    actual = [c["distance_m"] / 1000 for c in result.get("route_plan", {}).get("candidates", [])]
    print(f"\n用户：{message}\n结果：{result['status']}；有效候选距离(km)：{actual}\n回复：{result.get('answer', '')}")
    return result, dialogue


def test_kyoto_distance_dialogue_preserves_target_and_failed_edit(map_replies):
    replies, observed = map_replies
    created, history = turn("京都市内风景好的 30 km 环线", "create_route_plan", create_arguments(), number=1)
    view = created["route_plan"]
    assert created["status"] == "completed"
    assert [c["distance_m"] for c in view["candidates"]] == [29800]
    assert view["active_candidate_id"] == "candidate_2"
    assert len(view["rejected_candidates"]) == 2
    assert "实际 11.1 km，目标 30.0 km" in view["rejected_candidates"][0]["reason"]
    assert view["rejected_candidates"][1]["stage"] == "place_search"
    assert {target for _, target in observed} == {30}
    reference = {"plan_id": view["plan_id"], "revision": view["revision"]}
    replies["东山"] = 39400
    updated, history = turn("改成 40 km，仍要环线", "update_route_plan", {
        "operation": "replace_waypoints", "waypoints": ["京都站", "东山", "京都站"],
        "target_distance_km": 40,
    }, number=2, reference=reference, history=history)
    view = updated["route_plan"]
    assert view["candidates"][0]["distance_m"] == 39400
    reference["revision"] = view["revision"]
    before = RoutePlanStore().get(view["plan_id"])
    replies["鸭川"] = 11100
    failed, history = turn("改走鸭川，保留刚才的距离", "update_route_plan", {
        "operation": "replace_waypoints", "waypoints": ["京都站", "鸭川", "京都站"],
    }, number=3, reference=reference, history=history)
    assert failed["status"] == "route_rejected"
    assert "route_plan" not in failed
    assert "目标 40.0 km" in failed["error"]["message"]
    assert RoutePlanStore().get(view["plan_id"]) == before
    assert observed[-1][1] == 40
    replies["鸭川"] = 29900
    recovered, _ = turn("那就改回 30 km", "update_route_plan", {
        "operation": "replace_waypoints", "waypoints": ["京都站", "鸭川", "京都站"],
        "target_distance_km": 30,
    }, number=4, reference=reference, history=history)
    assert recovered["route_plan"]["candidates"][0]["distance_m"] == 29900


def test_no_distance_compliant_candidate_is_not_success(map_replies):
    replies, _ = map_replies
    replies.update({"东山": 12300, "岚山": 1474800})
    result, _ = turn("京都市内风景好的 30 km 环线", "create_route_plan", create_arguments(), number=1)
    assert result["status"] == "route_rejected"
    assert result["route_task"]["status"] == "failed"
    assert "route_plan" not in result
    assert RoutePlanStore().get_latest("dialogue") is None


def test_explicit_waypoints_without_distance_do_not_invent_a_target(map_replies):
    result, _ = turn("京都站经鸭川回到京都站，不限距离", "create_route_plan", {
        "country_code": "JP", "segment_strategy": "ignore",
        "candidates": [{"name": "鸭川环线", "waypoints": ["京都站", "鸭川", "京都站"]}],
    }, number=1)
    assert result["route_plan"]["candidates"][0]["distance_m"] == 11100


def test_short_candidates_plus_gateway_failure_report_both_reasons(map_replies):
    replies, _ = map_replies
    replies["东山"] = 12300
    result, _ = turn("京都市内风景好的 30 km 环线", "create_route_plan", create_arguments(), number=1)
    assert result["status"] == "provider_error"
    assert "route_plan" not in result
    assert "Google Places" in result["error"]["message"]
    assert "实际 11.1 km，目标 30.0 km" in result["error"]["message"]
    assert "实际 12.3 km，目标 30.0 km" in result["error"]["message"]
