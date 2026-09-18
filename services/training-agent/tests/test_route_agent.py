"""Deterministic Route Agent ownership, clarification and terminal outcomes."""
from copy import deepcopy
from unittest.mock import Mock
import pytest

from agent.route.agent import run_route_agent
from agent.route.contracts import RouteTaskInput
from agent.main_agent import result_builder
from agent.route import agent
from integrations.provider_error import TransientProviderError


class Client:
    def __init__(self, tool, arguments):
        self.tool, self.arguments = tool, arguments
        self.calls = []

    def create_messages(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        return {"stop_reason": "tool_use", "content": [{
            "type": "tool_use", "id": "call", "name": self.tool, "input": self.arguments,
        }]}


def task(**kwargs):
    return RouteTaskInput(message="京都 30km", workspace_id="workspace", request_id="request", **kwargs)


def test_clarification_has_no_provider_or_old_plan_and_isolated_history():
    history = [{"role": "user", "content": "帮我规划一圈"}]
    client = Client("request_route_clarification", {"question": "从哪个城市出发？"})
    result, dialogue = run_route_agent(task(), history=history, client=client)
    assert result["status"] == result["route_task"]["status"] == "clarification_required"
    assert "route_plan" not in result and "error" not in result
    assert history == [{"role": "user", "content": "帮我规划一圈"}]
    assert dialogue[-1]["content"] == "从哪个城市出发？"
    assert len(client.calls) == 1
    names = {tool["name"] for tool in client.calls[0]["tools"]}
    assert names == {"create_route_plan", "request_route_clarification", "search_cycling_routes", "prepare_route_materials"}


def test_create_terminal_has_plan_and_exact_action_without_second_model_call(monkeypatch):
    plan = {"plan_id": "plan", "workspace_id": "workspace", "revision": 1}
    monkeypatch.setattr(result_builder, "RoutePlanStore", lambda: Mock(get=lambda _: plan))
    monkeypatch.setattr(result_builder, "build_route_plan_view", lambda value: value)
    monkeypatch.setitem(agent.TOOL_HANDLERS, "create_route_plan", lambda args, context: {
        "status": "completed", "answer": "已创建", "result": {"plan_id": "plan"},
    })
    client = Client("create_route_plan", {})
    result, _ = run_route_agent(task(), client=client)
    assert result["route_plan"]["plan_id"] == "plan"
    assert result["route_task"]["action"] == "create"
    assert result["route_task"]["revision"] == 1
    assert len(client.calls) == 1


def test_update_reference_is_server_bound_and_virtual_options_do_not_leak(monkeypatch):
    plan = {"plan_id": "plan", "workspace_id": "workspace", "revision": 2}
    monkeypatch.setattr(agent, "RoutePlanStore", lambda: Mock(get=lambda _: plan))
    monkeypatch.setattr(result_builder, "RoutePlanStore", lambda: Mock(get=lambda _: plan))
    monkeypatch.setattr(result_builder, "build_route_plan_view", lambda value: value)
    seen = []

    def update(args, context):
        seen.append((args, context.route_request_options, context.selected_activities))
        return {"status": "completed", "answer": "已更新", "result": {"plan_id": "plan"}}

    monkeypatch.setitem(agent.TOOL_HANDLERS, "update_route_plan", update)
    result, _ = run_route_agent(task(action="update", plan_id="plan", revision=2), client=Client(
        "update_route_plan", {"plan_id": "other", "_expected_revision": 99, "operation": "replace_waypoints"},
    ))
    assert seen[0][0]["plan_id"] == "plan" and seen[0][0]["_expected_revision"] == 2
    assert seen[0][1] == {"include_elevation": False} and seen[0][2] == []
    assert result["route_task"]["action"] == "update"


def test_stale_or_foreign_reference_never_calls_model(monkeypatch):
    monkeypatch.setattr(agent, "RoutePlanStore", lambda: Mock(get=lambda _: {
        "workspace_id": "foreign", "revision": 2,
    }))
    client = Client("create_route_plan", {})
    result, _ = run_route_agent(task(action="refine", plan_id="plan", revision=2), client=client)
    assert result["error"]["code"] == "route_reference_conflict"
    assert client.calls == [] and "route_plan" not in result


def test_illegal_activity_call_is_blocked_and_never_executes():
    result, _ = run_route_agent(task(), client=Client("resolve_activities", {}))
    assert result["error"]["code"] == "guard_rejected"
    assert result["route_task"]["status"] == "failed"
    assert result["route_task"]["action_executed"] is False


def test_contract_requires_paired_positive_revision():
    with pytest.raises(ValueError):
        task(plan_id="plan")
    with pytest.raises(ValueError):
        task(plan_id="plan", revision=0)


def test_success_without_route_projection_is_not_reported_as_completed(monkeypatch):
    monkeypatch.setitem(agent.TOOL_HANDLERS, "create_route_plan", lambda args, ctx: {
        "status": "completed", "answer": "已创建", "result": {},
    })
    result, _ = run_route_agent(task(), client=Client("create_route_plan", {}))
    assert result["status"] == result["route_task"]["status"] == "failed"
    assert result["error"]["code"] == "route_result_missing"


def test_provider_failure_is_not_nonexecution_or_model_retry(monkeypatch):
    def create(args, context):
        raise TransientProviderError("Google 连接失败", provider="google_places", stage="place_search")
    monkeypatch.setitem(agent.TOOL_HANDLERS, "create_route_plan", create)
    client = Client("create_route_plan", {})
    result, _ = run_route_agent(task(), client=client)
    assert result["error"]["provider"] == "google_places"
    assert result["error"]["retryable"] is True
    assert result["route_task"]["action"] == "create"
    assert result["route_task"]["action_executed"] is True
    assert result["route_task"]["status"] == "failed"
    assert "route_plan" not in result
    assert len(client.calls) == 1


@pytest.mark.parametrize("outcome", ["completed", "clarification_required", "provider_error"])
def test_main_delegates_once_projects_child_outcome_and_isolates_history(monkeypatch, tmp_path, outcome):
    from agent.main_agent.context import AgentContext
    from agent.main_agent import loop
    from agent.route import delegation
    from agent.skills import get_skill
    monkeypatch.setenv("RIDER_LOG_DIR", str(tmp_path / "logs"))
    ctx = AgentContext(session_id="main", workspace_id="workspace", request_id="request",
                       selected_activities=[{"activity_key": "private-activity"}], analysis_navigation={})
    child = {"status": outcome, "answer": "子任务真实结果", "route_task": {
        "schema_version": "route_task.v1", "status": "failed" if outcome == "provider_error" else outcome,
        "action": "create", "action_executed": outcome != "clarification_required", "request_id": "request",
    }}
    if outcome == "completed":
        child["route_plan"] = {"plan_id": "plan", "revision": 1}
    elif outcome == "provider_error":
        child["error"] = {"code": "provider_connection_failed", "provider": "google_places",
                          "stage": "place_search", "retryable": True, "message": "连接失败"}
    calls = []
    def run(task, *, history):
        calls.append(task)
        assert task.message == "原始路线需求"
        assert task.options == {"include_elevation": False}
        assert history == []
        return deepcopy(child), [{"role": "assistant", "content": "仅子任务历史"}]
    monkeypatch.setattr(delegation, "run_route_agent", run)
    client = Mock()
    client.create_messages.side_effect = [
        {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "activate", "name": "activate_skill", "input": {"skill_id": "plan-routes"}}]},
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "delegate", "name": "run_route_agent", "input": {"message": "模型改写", "action": "create"}},
            {"type": "tool_use", "id": "duplicate", "name": "run_route_agent", "input": {"message": "重复", "action": "create"}},
        ]},
    ]
    monkeypatch.setattr(loop, "AnthropicMessagesClient", lambda: client)
    result = loop.run_tool_loop("原始路线需求", context=ctx)
    assert len(calls) == 1 and client.create_messages.call_count == 2
    assert get_skill("plan-routes").tool_names == ("run_route_agent",)
    assert result["status"] == outcome and result["answer"] == child["answer"]
    assert result.get("error") == child.get("error")
    assert result.get("route_plan") == child.get("route_plan")
    assert [r["tool"] for r in ctx.execution_trace] == ["run_route_agent"]
    assert ctx.last_failed_action is None
    assert ctx.selected_activities == [{"activity_key": "private-activity"}]
    assert ctx.messages[-1]["content"] == child["answer"]
    assert "仅子任务历史" not in str(ctx.messages)


def test_delegation_continues_clarification_without_old_plan_or_parent_history(monkeypatch):
    from agent.main_agent.context import AgentContext
    from agent.route import delegation
    ctx = AgentContext(session_id="main", workspace_id="workspace",
                       route_reference={"plan_id": "old", "revision": 9},
                       route_messages=[{"role": "user", "content": "旧路线"}])
    tasks = []
    def run(task, *, history):
        tasks.append((task, deepcopy(history)))
        return {"status": "clarification_required", "answer": "从哪个城市出发？",
                "route_task": {"status": "clarification_required"}}, [{"role": "assistant", "content": "从哪个城市出发？"}]
    monkeypatch.setattr(delegation, "run_route_agent", run)
    delegation.delegate_route_task({"message": "另建一圈", "action": "create"}, ctx)
    assert ctx.route_reference is None
    delegation.delegate_route_task({"message": "京都", "action": "refine"}, ctx)
    assert tasks[0][0].plan_id is None and tasks[0][1] == []
    assert tasks[1][0].plan_id is None
    assert tasks[1][1] == [{"role": "assistant", "content": "从哪个城市出发？"}]


def test_route_delegation_cannot_hide_an_earlier_guard_failure(monkeypatch):
    from agent.main_agent.context import AgentContext
    from agent.main_agent import loop
    ctx = AgentContext(session_id="guarded-parent", analysis_navigation={})
    client = Mock()
    client.create_messages.side_effect = [
        {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "activate", "name": "activate_skill", "input": {"skill_id": "plan-routes"}}]},
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "bypass", "name": "create_route_plan", "input": {}},
            {"type": "tool_use", "id": "delegate", "name": "run_route_agent", "input": {"message": "路线", "action": "create"}},
        ]},
    ]
    monkeypatch.setattr(loop, "AnthropicMessagesClient", lambda: client)
    result = loop.run_tool_loop("规划路线", context=ctx)
    assert result["status"] == "blocked"
    assert result["error"]["code"] == "guard_rejected"
    assert len(ctx.execution_trace) == 1
    assert ctx.execution_trace[0]["tool"] == "create_route_plan"
    assert "route_plan" not in result


@pytest.mark.parametrize("initial_action", ["create", "refine"])
def test_failed_new_task_never_reuses_old_plan_after_session_restore(monkeypatch, tmp_path, initial_action):
    from app.chat_sessions import ChatSessionStore
    from agent.route import delegation
    db = tmp_path / "sessions.db"
    session = ChatSessionStore(database=db).get_or_create("new-task")
    ctx = session.context
    ctx.route_reference = {"plan_id": "japan", "revision": 2}
    ctx.route_messages = [{"role": "user", "content": "日本路线"}]
    seen = []
    def fail(task, *, history):
        seen.append((task, deepcopy(history)))
        return {"status": "provider_error", "answer": "法国地点连接失败",
                "error": {"code": "provider_connection_failed", "retryable": True},
                "route_task": {"action": "create", "status": "failed"}}, [
                    {"role": "user", "content": "另建法国路线"},
                    {"role": "assistant", "content": "法国地点连接失败"}]
    monkeypatch.setattr(delegation, "run_route_agent", fail)
    first = delegation.delegate_route_task({"message": "另建法国路线", "action": initial_action}, ctx)
    assert ctx.route_reference is None
    session.cache_response("new-france", "france", first)
    restored = ChatSessionStore(database=db).get_or_create("new-task").context
    delegation.delegate_route_task({"message": "换一个途经点再规划", "action": "refine"}, restored)
    assert seen[1][0].plan_id is None and seen[1][0].revision is None
    assert "法国" in str(seen[1][1])
    assert "日本" not in str(seen[1][1])


@pytest.mark.parametrize("model_value", [None, True, False])
def test_confirmed_plan_update_passes_trusted_no_elevation_to_service(monkeypatch, model_value):
    from agent.tools.handlers import route
    plan = {"plan_id": "plan", "workspace_id": "workspace", "revision": 2,
            "planning": {"status": "confirmed"}, "candidates": [], "country_code": "JP"}
    store = Mock(get=lambda _: deepcopy(plan), save=lambda value, **kwargs: value)
    monkeypatch.setattr(agent, "RoutePlanStore", lambda: store)
    monkeypatch.setattr(route, "RoutePlanStore", lambda: store)
    monkeypatch.setattr(result_builder, "RoutePlanStore", lambda: store)
    monkeypatch.setattr(result_builder, "build_route_plan_view", lambda p: p)
    monkeypatch.setattr(route, "compact_route_plan", lambda p: p)
    monkeypatch.setattr(route, "_plan_answer", lambda *a, **kw: "已更新")
    monkeypatch.setattr(route, "apply_plan_route_constraints", lambda p, *a, **kw: p)
    received = []
    def replace(p, **kwargs):
        received.append(kwargs)
        return p
    monkeypatch.setattr(route, "replace_candidate", replace)
    arguments = {"operation": "replace_waypoints", "waypoints": ["京都", "大津"]}
    if model_value is not None:
        arguments["include_elevation"] = model_value
    result, _ = run_route_agent(task(action="update", plan_id="plan", revision=2),
                               client=Client("update_route_plan", arguments))
    assert result["route_task"]["status"] == "completed"
    assert len(received) == 1 and received[0]["include_elevation"] is False
    assert arguments.get("include_elevation") is model_value


@pytest.mark.parametrize("replace_requirements", [False, True])
def test_refine_uses_selected_candidate_and_regenerates_prepared_group(monkeypatch, tmp_path, replace_requirements):
    monkeypatch.setenv('RIDER_LOG_DIR', str(tmp_path))
    old = {'plan_id': 'old', 'workspace_id': 'workspace', 'revision': 2,
           'route_constraints': {'avoid_repeated_roads': True},
           'active_candidate_id': 'b', 'candidates': [
               {'candidate_id': 'a', 'name': '未选中的路线'},
               {'candidate_id': 'b', 'name': '选中的鸭川路线', 'waypoints': [{'name': '京都站'}, {'name': '鸭川'}]}]}
    new = {'plan_id': 'new', 'workspace_id': 'workspace', 'revision': 1,
           'candidates': [{'candidate_id': str(i)} for i in range(3)]}
    monkeypatch.setattr(agent, 'RoutePlanStore', lambda: Mock(get=lambda _: old))
    monkeypatch.setattr(result_builder, 'RoutePlanStore', lambda: Mock(get=lambda _: new))
    monkeypatch.setattr(result_builder, 'build_route_plan_view', lambda p: p)
    def prepare(args, context):
        context.route_preparation = {'status': 'prepared', 'requirement_changes': {
            'mode': 'replace' if replace_requirements else 'merge'}}
        return context.route_preparation
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'prepare_route_materials', prepare)
    create = Mock(return_value={'status': 'completed', 'result': {'plan_id': 'new'}})
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'create_route_plan', create)
    update = Mock()
    monkeypatch.setitem(agent.TOOL_HANDLERS, 'update_route_plan', update)
    class RegenerateClient:
        n = 0
        def create_messages(self, **kwargs):
            self.n += 1
            assert '选中的鸭川路线' in kwargs['system']
            assert '未选中的路线' not in kwargs['system']
            tools = {t['name'] for t in kwargs['tools']}
            assert 'update_route_plan' not in tools
            assert ('create_route_plan' in tools) == (self.n > 1)
            return {'stop_reason': 'tool_use', 'content': [{'type': 'tool_use', 'id': str(self.n),
                'name': 'prepare_route_materials' if self.n == 1 else 'create_route_plan', 'input': {}}]}
    result, _ = run_route_agent(task(action='refine', plan_id='old', revision=2), client=RegenerateClient())
    assert result['status'] == 'completed'
    assert len(result['route_plan']['candidates']) == 3
    assert create.call_args.args[0]['use_prepared_candidates'] is True
    assert create.call_args.args[0]['route_constraints'] == ({} if replace_requirements else old['route_constraints'])
    update.assert_not_called()
    assert old['revision'] == 2
