from copy import deepcopy
from unittest.mock import Mock

import pytest

from agent.route import agent
from agent.route.contracts import RouteTaskInput
from agent.main_agent import result_builder
from storage.repositories.route_workflow import RouteWorkflowStore


@pytest.mark.parametrize("stage,tool,success", [("research", "search_cycling_routes", "ok"),
                                               ("materials", "prepare_route_materials", "prepared")])
@pytest.mark.parametrize("recover", [False, True])
def test_latest_stage_attempt_is_authoritative_and_durable(monkeypatch, stage, tool, success, recover):
    plan = {"plan_id": "p", "workspace_id": "w", "revision": 1}
    monkeypatch.setattr(result_builder, "RoutePlanStore", lambda: Mock(get=lambda _: plan))
    monkeypatch.setattr(result_builder, "build_route_plan_view", lambda value: value)
    calls = []

    def prepare(args, context):
        calls.append(args)
        if len(calls) == 1 or not recover:
            return {"status": "failed", "code": "place_ambiguous", "message": "地点不明确"}
        if stage == "materials":
            context.route_preparation = {"materials": {"locality": "京都"}}
        return {"status": success}

    def create(args, context):
        saved = RouteWorkflowStore().get("w", "request")
        assert saved["stages"][stage]["state"] == "completed"
        assert saved["stages"][stage]["attempts"] == 2
        assert saved["stages"]["routing"]["state"] == "running"
        return {"status": "completed", "result": {"plan_id": "p"}}

    create = Mock(side_effect=create)
    monkeypatch.setitem(agent.TOOL_HANDLERS, tool, prepare)
    monkeypatch.setitem(agent.TOOL_HANDLERS, "create_route_plan", create)
    client = Mock()
    client.create_messages.side_effect = [{"stop_reason": "tool_use", "content": [
        {"type": "tool_use", "id": str(i), "name": name, "input": args}]} for i, (name, args) in enumerate([
            (tool, {"query": "泛称"}), (tool, {"query": "入口和出口"}), ("create_route_plan", {})])] + [
                {"stop_reason": "end_turn", "content": [{"type": "text", "text": "未完成"}]}]
    result, _ = agent.run_route_agent(RouteTaskInput("规划", "w", "request"), client=client)
    saved = RouteWorkflowStore().get("w", "request")
    assert result["executions"][0]["status"] == "failed"
    assert saved["stages"][stage]["state"] == ("completed" if recover else "blocked")
    assert saved["status"] == ("completed" if recover else "interrupted")
    assert create.call_count == int(recover)
    assert bool(result.get("route_plan")) == recover
    if not recover:
        assert result["error"]["code"] == "place_ambiguous"


def test_restarting_research_invalidates_materials_before_io():
    from agent.main_agent.context import AgentContext
    from agent.route.workflow import RouteWorkflow
    context = AgentContext(session_id="s", workspace_id="w", request_id="r")
    workflow = RouteWorkflow(context)
    context.route_preparation = {"materials": {"locality": "京都"}}
    workflow.start("prepare_route_materials")
    workflow.finish("prepare_route_materials", {"status": "prepared"}, {})
    old = deepcopy(workflow.snapshot)
    workflow.start("search_cycling_routes")
    assert old["stages"]["materials"]["state"] == "completed"
    assert context.route_preparation is None
    assert RouteWorkflowStore().get("w", "r")["stages"]["materials"]["state"] == "pending"
    workflow.finish("search_cycling_routes", {"status": "unexpected"}, {})
    assert workflow.failure()["tool"] == "search_cycling_routes"
    assert workflow.failure()["result"]["code"] == "route_stage_result_missing"
