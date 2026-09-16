"""run_tool_loop 的执行、重试与工具依赖测试。"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from agent.main_agent.context import AgentContext
from agent.main_agent.execution_policy import TurnExecutionPolicy
from integrations.llm import LLMRequestError
from integrations.provider_error import TransientProviderError
from agent.main_agent.loop import MAX_TOOL_STEPS, _build_state_preamble, _build_system_prompt, run_tool_loop
from agent.main_agent.turn_policy import should_continue_route_skill
from project_paths import resolve_project_path
from services.route.single_day import RouteProviderFailed


@pytest.fixture(autouse=True)
def isolate_chat_logs(tmp_path, monkeypatch):
    """Tool-loop tests must never append logs to the user's runtime data."""
    monkeypatch.setenv("RIDER_LOG_DIR", str(tmp_path / "logs"))


def _activation_response(skill_id):
    return {
        "id": "msg-activate",
        "content": [{
            "type": "tool_use", "name": "activate_skill", "id": "tu-activate",
            "input": {"skill_id": skill_id},
        }],
        "stop_reason": "tool_use",
    }


def test_main_prompt_does_not_leak_unselected_skill_tools():
    prompt = _build_system_prompt()
    assert "run_activity_workflow" not in prompt
    assert "sync_and_run_activity_workflow" not in prompt
    assert "尚未激活领域 Skill" in prompt
    assert "每个用户回合最多激活一个 Skill" in prompt
    assert "必须等到下一次模型调用" in prompt
    assert "独立选择阶段决定" not in prompt
    assert "确认" not in prompt


def test_ordinary_chat_answers_in_one_main_model_request():
    context = AgentContext(session_id="one-call-chat")
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-chat",
            "content": [{"type": "text", "text": "你好。"}],
            "stop_reason": "end_turn",
        }

        result = run_tool_loop("你好", context=context)

    assert result["status"] == "completed"
    assert result["skill_id"] is None
    assert result["answer"] == "你好。"
    assert client.return_value.create_message.call_count == 0
    assert client.return_value.create_messages.call_count == 1
    tools = client.return_value.create_messages.call_args.kwargs["tools"]
    assert [tool["name"] for tool in tools] == ["activate_skill"]


def test_explicit_route_followup_reuses_recent_skill_without_becoming_a_required_action(monkeypatch):
    context = AgentContext(
        session_id="route-followup", workspace_id="workspace", last_used_skills=["plan-routes"],
    )
    monkeypatch.setattr("agent.main_agent.loop.should_continue_route_skill", lambda *_: True)
    monkeypatch.setattr("agent.main_agent.turn_policy.should_continue_route_skill", lambda *_: True)
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-route-text-only",
            "content": [{"type": "text", "text": "已更新路线。"}],
            "stop_reason": "end_turn",
        }

        result = run_tool_loop("在当前路线中增加一个途经点", context=context)

    assert result["status"] == "completed"
    assert result["answer"] == "已更新路线。"
    assert context.active_skill_id == "plan-routes"
    assert context.active_skill_reason == "continued_from_recent_skill"
    assert context.last_used_skills == ["plan-routes"]
    assert context.conversation_used_skills == ["plan-routes"]
    tools = client.return_value.create_messages.call_args.kwargs["tools"]
    names = {tool["name"] for tool in tools}
    assert "update_route_plan" in names
    assert "activate_skill" not in names


def test_trusted_route_request_forces_route_skill_and_fails_closed_without_tool():
    context = AgentContext(
        session_id="trusted-route-request",
        workspace_id="workspace",
        route_request_options={"include_elevation": False},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-route-text-only",
            "content": [{"type": "text", "text": "本轮已生成三条路线。"}],
            "stop_reason": "end_turn",
        }

        result = run_tool_loop(
            "规划一条京都 30 km 环线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert result["status"] == "action_not_executed"
    assert "本轮已生成三条路线" not in result["answer"]
    assert context.active_skill_id == "plan-routes"
    assert context.active_skill_reason == "request_policy"
    assert context.last_used_skills == ["plan-routes"]
    assert context.conversation_used_skills == ["plan-routes"]
    tools = client.return_value.create_messages.call_args.kwargs["tools"]
    names = {tool["name"] for tool in tools}
    assert "create_route_plan" in names
    assert "activate_skill" not in names
    assert client.return_value.create_messages.call_args.kwargs["tool_choice"] == {
        "type": "tool", "name": "create_route_plan",
    }
    assert client.return_value.create_messages.call_args.kwargs["thinking"] == "disabled"


def test_trusted_route_request_stops_forcing_tools_after_failed_attempt(monkeypatch):
    context = AgentContext(
        session_id="trusted-route-failed-tool",
        workspace_id="workspace",
        route_request_options={"include_elevation": False},
    )
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "create_route_plan",
        lambda args, ctx: {"status": "failed", "error": "Google route request timed out"},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            {
                "id": "msg-route-tool",
                "content": [{
                    "type": "tool_use",
                    "name": "create_route_plan",
                    "id": "tu-route",
                    "input": {"name": "京都环线", "country_code": "JP", "candidates": []},
                }],
                "stop_reason": "tool_use",
            },
            {
                "id": "msg-route-failed",
                "content": [{"type": "text", "text": "路线服务失败。"}],
                "stop_reason": "end_turn",
            },
        ]

        result = run_tool_loop(
            "规划一条京都 30 km 环线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert result["status"] == "action_not_executed"
    calls = client.return_value.create_messages.call_args_list
    assert calls[0].kwargs["tool_choice"] == {"type": "tool", "name": "create_route_plan"}
    assert len(calls) == 1
    assert len(result["executions"]) == 1
    assert result["executions"][0]["status"] == "failed"


def test_trusted_route_request_stops_after_required_tool_is_guarded(monkeypatch):
    from agent.main_agent.guard import GuardResult

    context = AgentContext(session_id="trusted-route-guarded", workspace_id="workspace")
    monkeypatch.setattr(
        "agent.main_agent.guard.guard_tool_call",
        lambda *args, **kwargs: GuardResult(False, "blocked by deterministic guard"),
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-route-tool",
            "content": [{
                "type": "tool_use", "name": "create_route_plan", "id": "tu-route", "input": {},
            }],
            "stop_reason": "tool_use",
        }

        result = run_tool_loop(
            "规划京都路线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert result["status"] == "action_not_executed"
    assert result["executions"] == []
    assert context.last_failed_action is None
    assert client.return_value.create_messages.call_count == 1


def test_route_provider_failure_keeps_structured_error_and_stops(monkeypatch):
    context = AgentContext(session_id="route-provider-failure", workspace_id="workspace")
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "create_route_plan",
        lambda args, ctx: (_ for _ in ()).throw(RouteProviderFailed([{
            "code": "provider_unavailable",
            "provider": "google_places",
            "stage": "place_search",
            "retryable": True,
            "message": "TLS timeout",
        }])),
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-route-tool",
            "content": [{
                "type": "tool_use", "name": "create_route_plan", "id": "tu-route",
                "input": {"title": "京都环线", "country_code": "JP", "candidates": []},
            }],
            "stop_reason": "tool_use",
        }
        result = run_tool_loop(
            "规划京都路线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert result["status"] == "provider_error"
    assert result["answer"] == "路线服务暂时不可用，请稍后重试。"
    assert result["executions"][0]["error"] == "route_provider_error"
    assert client.return_value.create_messages.call_count == 1


def test_direct_update_provider_failure_keeps_adapter_error_fields(monkeypatch):
    context = AgentContext(session_id="route-update-provider-failure", workspace_id="workspace")
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "update_route_plan",
        lambda args, ctx: (_ for _ in ()).throw(TransientProviderError(
            "Google Routes request timed out",
            provider="google_routes",
            stage="route_calculation",
        )),
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-route-update-tool",
            "content": [{
                "type": "tool_use", "name": "update_route_plan", "id": "tu-route-update",
                "input": {"plan_id": "plan-1", "operation": "replace_waypoints"},
            }],
            "stop_reason": "tool_use",
        }
        result = run_tool_loop(
            "修改京都路线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("update"),
        )

    assert result["status"] == "provider_error"
    assert result["executions"][0]["code"] == "provider_unavailable"
    assert result["executions"][0]["provider"] == "google_routes"
    assert result["executions"][0]["stage"] == "route_calculation"
    assert result["executions"][0]["retryable"] is True
    assert client.return_value.create_messages.call_count == 1


def test_trusted_route_request_fails_closed_when_llm_is_unavailable():
    context = AgentContext(
        session_id="trusted-route-llm-unavailable",
        workspace_id="workspace",
        route_request_options={"include_elevation": False},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = LLMRequestError("connection closed")

        result = run_tool_loop(
            "规划一条京都 30 km 环线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert result["status"] == "action_not_executed"
    assert result["intent"] == "route_advice"
    assert result["skill_id"] == "plan-routes"
    assert result["executions"] == []
    assert context.last_llm_error["type"] == "LLMRequestError"


def test_route_policy_clears_stale_execution_before_client_initialization_failure():
    context = AgentContext(session_id="stale-route-client-failure", workspace_id="workspace")
    context.execution_trace = [{
        "tool": "get_route_plan",
        "status": "completed",
        "result": {"status": "completed", "result": {"plan_id": "old-plan"}},
    }]
    with patch("agent.main_agent.loop.AnthropicMessagesClient", side_effect=RuntimeError("missing model")):
        result = run_tool_loop(
            "规划京都路线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert result["status"] == "action_not_executed"
    assert result["executions"] == []
    assert "route_plan" not in result


def test_refine_policy_allows_create_or_update_but_not_read_only_route_tools(monkeypatch):
    context = AgentContext(session_id="refine-cross-region", workspace_id="workspace")
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "create_route_plan",
        lambda args, ctx: {
            "status": "completed", "answer": "已创建安纳西路线",
            "result": {"plan_id": "fr-plan"},
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-refine-create",
            "content": [{
                "type": "tool_use", "name": "create_route_plan", "id": "tu-create",
                "input": {"title": "安纳西环线", "country_code": "FR", "candidates": []},
            }],
            "stop_reason": "tool_use",
        }
        result = run_tool_loop(
            "把当前杭州路线改成法国安纳西路线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("refine"),
        )

    assert result["status"] == "completed"
    call = client.return_value.create_messages.call_args
    assert call.kwargs["tool_choice"] == {"type": "any"}
    assert {tool["name"] for tool in call.kwargs["tools"]} == {
        "create_route_plan", "update_route_plan",
    }
    assert [item["tool"] for item in result["executions"]] == ["create_route_plan"]


def test_create_policy_is_not_completed_by_reading_an_old_route(monkeypatch):
    context = AgentContext(session_id="create-read-old-route", workspace_id="workspace")
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "get_route_plan",
        lambda args, ctx: {
            "status": "completed", "answer": "读取旧路线",
            "result": {"plan_id": "old-plan"},
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            {
                "id": "msg-wrong-tool",
                "content": [{
                    "type": "tool_use", "name": "get_route_plan", "id": "tu-old", "input": {},
                }],
                "stop_reason": "tool_use",
            },
            {"id": "msg-text", "content": [{"type": "text", "text": "已生成。"}], "stop_reason": "end_turn"},
        ]
        result = run_tool_loop(
            "规划京都路线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert result["status"] == "action_not_executed"
    assert [item["tool"] for item in result["executions"]] == ["get_route_plan"]
    assert "route_plan" not in result


def test_retrying_a_route_action_projects_the_completed_plan(monkeypatch):
    context = AgentContext(
        session_id="retry-route-plan",
        workspace_id="workspace",
        active_skill_id="plan-routes",
        last_failed_action={"tool": "update_route_plan", "input": {"plan_id": "plan-1"}},
    )
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "update_route_plan",
        lambda args, ctx: {
            "status": "completed", "answer": "路线已更新",
            "result": {"plan_id": "plan-1"},
        },
    )
    monkeypatch.setattr(
        "agent.main_agent.result_builder.RoutePlanStore.get",
        lambda self, plan_id: {
            "plan_id": plan_id, "revision": 2,
            "candidates": [{"candidate_id": "candidate-1"}],
        },
    )

    result = run_tool_loop("重试", context=context)

    assert result["status"] == "completed"
    assert result["route_plan"]["plan_id"] == "plan-1"


def test_route_retry_obeys_current_create_policy_instead_of_replaying_update(monkeypatch):
    context = AgentContext(
        session_id="retry-route-create-policy",
        workspace_id="workspace",
        active_skill_id="plan-routes",
        last_failed_action={"tool": "update_route_plan", "input": {"plan_id": "old-plan"}},
    )
    update_calls = []
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "update_route_plan",
        lambda args, ctx: update_calls.append(args) or {"status": "completed"},
    )
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "create_route_plan",
        lambda args, ctx: {
            "status": "completed", "answer": "新路线已生成",
            "result": {"plan_id": "new-plan"},
        },
    )
    monkeypatch.setattr(
        "agent.main_agent.result_builder.RoutePlanStore.get",
        lambda self, plan_id: {
            "plan_id": plan_id, "revision": 1,
            "candidates": [{"candidate_id": "candidate-1"}],
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-create-route",
            "content": [{
                "type": "tool_use", "name": "create_route_plan", "id": "tu-create",
                "input": {"title": "新路线", "country_code": "JP", "candidates": []},
            }],
            "stop_reason": "tool_use",
        }
        result = run_tool_loop(
            "重试",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert update_calls == []
    assert result["status"] == "completed"
    assert result["route_plan"]["plan_id"] == "new-plan"
    assert [item["tool"] for item in result["executions"]] == ["create_route_plan"]


def test_route_retry_of_required_action_uses_policy_failure_projection(monkeypatch):
    context = AgentContext(
        session_id="retry-required-route-action",
        workspace_id="workspace",
        active_skill_id="plan-routes",
        last_failed_action={"tool": "create_route_plan", "input": {"title": "京都路线"}},
    )
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "create_route_plan",
        lambda args, ctx: {
            "status": "failed",
            "error": "provider_unavailable",
            "code": "provider_unavailable",
            "provider": "google_places",
            "stage": "place_search",
            "message": "Google Places 暂时不可用",
            "retryable": True,
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        result = run_tool_loop(
            "重试",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert client.call_count == 0
    assert result["status"] == "provider_error"
    assert result["answer"] == "Google Places 暂时不可用"
    assert result["executions"][0]["retryable"] is True


def test_non_retryable_tool_failure_is_not_saved_by_loop_hooks(monkeypatch):
    context = AgentContext(
        session_id="non-retryable-route-failure",
        workspace_id="workspace",
        last_failed_action={"tool": "create_route_plan", "input": {"title": "旧请求"}},
    )
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "create_route_plan",
        lambda args, ctx: {
            "status": "failed",
            "error": "place_not_found",
            "code": "place_not_found",
            "message": "地点不存在",
            "retryable": False,
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.return_value = {
            "id": "msg-route-rejected",
            "content": [{
                "type": "tool_use", "name": "create_route_plan", "id": "tu-route-rejected",
                "input": {"title": "路线", "country_code": "JP", "candidates": []},
            }],
            "stop_reason": "tool_use",
        }
        result = run_tool_loop(
            "规划路线",
            context=context,
            execution_policy=TurnExecutionPolicy.route_plan("create"),
        )

    assert result["status"] == "route_rejected"
    assert context.last_failed_action is None


def test_route_followup_recognizes_waypoint_language(monkeypatch):
    class Store:
        def get_latest(self, workspace_id):
            assert workspace_id == "workspace"
            return {"plan_id": "route_test"}

    monkeypatch.setattr("storage.repositories.route.RoutePlanStore", Store)
    context = AgentContext(
        session_id="route-waypoint-followup",
        workspace_id="workspace",
        last_used_skills=["plan-routes"],
    )

    assert should_continue_route_skill("在第二个点位后加入 Lac Besson", context)


def test_pure_sync_executes_without_starting_analysis_workflow(monkeypatch):
    context = AgentContext(session_id="test-direct-sync")
    monkeypatch.setattr(
        "operations.activity.sync.sync_recent",
        lambda **kwargs: {"status": "completed", "downloaded": 2, "skipped": 1, "failed": 0},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("sync-garmin-activities"),
            {"id": "msg-sync", "content": [
                {"type": "tool_use", "name": "sync_garmin_activities", "id": "tu-sync", "input": {"count": 3}},
            ], "stop_reason": "tool_use"},
            {"id": "msg-done", "content": [{"type": "text", "text": "同步完成。"}], "stop_reason": "end_turn"},
        ]
        result = run_tool_loop("同步最近三条活动", context=context)

    assert result["status"] == "completed"
    assert result["steps"] == [{"tool": "sync_garmin_activities", "input": {"count": 3}}]
    assert result["answer"].endswith("同步完成。")
    assert result["answer"].startswith("已处理：本次 Garmin 同步｜同步 Garmin 活动")
    first_tools = client.return_value.create_messages.call_args_list[0].kwargs["tools"]
    assert [tool["name"] for tool in first_tools] == ["activate_skill"]
    second_tools = client.return_value.create_messages.call_args_list[1].kwargs["tools"]
    assert [tool["name"] for tool in second_tools] == ["sync_garmin_activities"]
    assert client.return_value.create_messages.call_args_list[2].kwargs["tools"] == []


def test_skill_activation_does_not_authorize_later_calls_in_the_same_response(monkeypatch):
    context = AgentContext(session_id="activation-barrier")
    calls: list[int] = []
    monkeypatch.setattr(
        "operations.activity.sync.sync_recent",
        lambda **kwargs: calls.append(1) or {"status": "completed"},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            {
                "id": "msg-invalid-batch",
                "content": [
                    {"type": "tool_use", "name": "activate_skill", "id": "tu-activate", "input": {"skill_id": "sync-garmin-activities"}},
                    {"type": "tool_use", "name": "sync_garmin_activities", "id": "tu-sync-early", "input": {"count": 3}},
                ],
                "stop_reason": "tool_use",
            },
            {"id": "msg-final", "content": [{"type": "text", "text": "未执行同步。"}], "stop_reason": "end_turn"},
        ]

        result = run_tool_loop("同步最近三条活动", context=context)

    assert result["status"] == "completed"
    assert calls == []
    assert result["steps"] == []


def test_completed_sync_workflow_hides_tools_before_final_response(monkeypatch):
    context = AgentContext(session_id="terminal-sync-workflow")
    monkeypatch.setattr(
        "operations.activity.workflow_service.sync_and_start_activity_workflow",
        lambda **kwargs: {"status": "completed", "workflow_id": "run-sync", "tasks": []},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("run-activity-workflow"),
            {"id": "msg-sync", "content": [{
                "type": "tool_use", "name": "sync_and_run_activity_workflow", "id": "tu-sync",
                "input": {"count": 3, "goals": ["upload_strava"]},
            }], "stop_reason": "tool_use"},
            {"id": "msg-final", "content": [{"type": "text", "text": "同步并上传完成。"}], "stop_reason": "end_turn"},
        ]

        result = run_tool_loop("同步最新三条活动并上传 Strava", context=context)

    assert result["steps"] == [{
        "tool": "sync_and_run_activity_workflow",
        "input": {"count": 3, "goals": ["upload_strava"]},
    }]
    assert client.return_value.create_messages.call_args_list[2].kwargs["tools"] == []


def test_second_sync_turn_replaces_previous_activity_focus(monkeypatch):
    context = AgentContext(session_id="two-sync-turns")
    workflow_results = iter([
        {
            "status": "completed", "workflow_id": "run-old",
            "sync": {"downloaded": 0, "skipped": 1},
            "activities": [{"activity_key": "old", "fit_path": "old.fit"}],
            "tasks": [{"status": "skipped"}],
        },
        {
            "status": "completed", "workflow_id": "run-new",
            "sync": {"downloaded": 1, "skipped": 0},
            "activities": [{"activity_key": "new", "fit_path": "new.fit"}],
            "tasks": [{"status": "completed"}],
        },
    ])
    monkeypatch.setattr(
        "operations.activity.workflow_service.sync_and_start_activity_workflow",
        lambda **kwargs: next(workflow_results),
    )
    monkeypatch.setattr(
        "agent.tools.handlers.activity_operations.ActivityStore.get_activity",
        lambda self, key: {
            "activity_key": key, "fit_path": f"{key}.fit", "sport_type": "cycling",
            "start_time_local": "2026-08-20T11:00:00",
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("run-activity-workflow"),
            {"content": [{
                "type": "tool_use", "name": "sync_and_run_activity_workflow", "id": "tu-sync-old",
                "input": {"count": 1, "goals": ["ensure_summary"]},
            }], "stop_reason": "tool_use"},
            {"content": [{"type": "text", "text": "第一次同步完成。"}], "stop_reason": "end_turn"},
            _activation_response("run-activity-workflow"),
            {"content": [{
                "type": "tool_use", "name": "sync_and_run_activity_workflow", "id": "tu-sync-new",
                "input": {"count": 1, "goals": ["ensure_summary"]},
            }], "stop_reason": "tool_use"},
            {"content": [{"type": "text", "text": "第二次同步完成。"}], "stop_reason": "end_turn"},
        ]

        first = run_tool_loop("同步 Garmin 最后一个活动并分析", context=context)
        second = run_tool_loop("手机同步好了，重新拉最后一个活动并分析", context=context)

    assert first["executions"][0]["result"]["workflow_id"] == "run-old"
    assert second["executions"][0]["result"]["workflow_id"] == "run-new"
    assert context.current_activity_key == "new"
    assert context.current_fit_file == resolve_project_path("new.fit")
    assert second["answer"].startswith("已处理：2026-08-20T11:00:00")


def test_terminal_tool_stops_later_calls_from_the_same_response(monkeypatch):
    context = AgentContext(session_id="terminal-batch")
    calls: list[str] = []
    monkeypatch.setattr(
        "operations.activity.workflow_service.sync_and_start_activity_workflow",
        lambda **kwargs: calls.append("sync") or {
            "status": "completed", "workflow_id": "run-sync", "tasks": [],
        },
    )
    monkeypatch.setattr(
        "operations.activity.workflow_service.start_local_activity_workflow",
        lambda **kwargs: calls.append("local") or {
            "status": "completed", "workflow_id": "run-local", "tasks": [],
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("run-activity-workflow"),
            {"id": "msg-batch", "content": [
                {"type": "tool_use", "name": "sync_and_run_activity_workflow", "id": "tu-sync", "input": {"count": 3}},
                {"type": "tool_use", "name": "run_activity_workflow", "id": "tu-local", "input": {"limit": 3}},
            ], "stop_reason": "tool_use"},
            {"id": "msg-final", "content": [{"type": "text", "text": "完成。"}], "stop_reason": "end_turn"},
        ]

        result = run_tool_loop("同步三个活动，然后处理本地活动", context=context)

    assert result["status"] == "completed"
    assert calls == ["sync"]
    assert result["steps"] == [{"tool": "sync_and_run_activity_workflow", "input": {"count": 3}}]


def test_retry_executes_last_failed_workflow_action():
    context = AgentContext(
        session_id="test-retry",
        active_skill_id="run-activity-workflow",
        last_failed_action={"tool": "retry_activity_workflow", "input": {"workflow_id": "run-1"}},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient"):
        with patch("operations.activity.workflow_service.retry_activity_workflow") as mock_retry:
            mock_retry.return_value = {"status": "completed", "workflow_id": "run-1"}
            result = run_tool_loop("再试一次", context=context)

    assert result["status"] == "completed"
    assert result["intent"] == "retry"
    assert context.last_failed_action is None
    assert mock_retry.called


def test_retry_reports_failure_when_saved_action_fails_again():
    context = AgentContext(
        session_id="test-retry-failed",
        active_skill_id="run-activity-workflow",
        last_failed_action={"tool": "retry_activity_workflow", "input": {"workflow_id": "run-1"}},
    )
    with patch("operations.activity.workflow_service.retry_activity_workflow") as mock_retry:
        mock_retry.return_value = {"status": "failed", "error": "still_broken"}
        result = run_tool_loop("重试", context=context)

    assert result["status"] == "failed"
    assert context.last_failed_action == {
        "tool": "retry_activity_workflow", "input": {"workflow_id": "run-1"},
    }
    assert "仍未完成" in result["answer"]


def test_llm_disconnect_keeps_completed_tool_state(monkeypatch):
    context = AgentContext(session_id="test-llm-disconnect")

    def fake_find(args, ctx):
        ctx.current_fit_file = Path("/tmp/resolved.fit")
        return {"step": "resolve_activities", "status": "completed"}

    monkeypatch.setitem(__import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS, "resolve_activities", fake_find)
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("analyze-activity"),
            {"id": "msg-find", "content": [{"type": "tool_use", "name": "resolve_activities", "id": "tu-find", "input": {"kind": "recent", "limit": 1}}], "stop_reason": "tool_use"},
            LLMRequestError("connection closed"),
        ]
        result = run_tool_loop("分析最近活动", context=context)

    assert result["status"] == "llm_unavailable"
    assert context.current_fit_file == Path("/tmp/resolved.fit")
    assert context.last_llm_error["type"] == "LLMRequestError"


def test_llm_disconnect_after_completed_workflow_reports_real_completion(monkeypatch):
    context = AgentContext(session_id="test-workflow-disconnect")
    monkeypatch.setattr(
        "operations.activity.workflow_service.sync_and_start_activity_workflow",
        lambda **kwargs: {
            "status": "completed",
            "workflow_id": "run-finished",
            "sync": {"downloaded": 2, "skipped": 1},
            "tasks": [
                {"status": "completed"}, {"status": "completed"}, {"status": "skipped"},
            ],
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("run-activity-workflow"),
            {"id": "msg-sync", "content": [
                {"type": "tool_use", "name": "sync_and_run_activity_workflow", "id": "tu-sync", "input": {"count": 3}},
            ], "stop_reason": "tool_use"},
            LLMRequestError("connection closed"),
        ]
        result = run_tool_loop("同步最新三条活动，分析并上传", context=context)

    assert result["status"] == "llm_unavailable"
    assert "工作流已完成：run-finished" in result["answer"]
    assert "同步：下载 2 条，跳过 1 条" in result["answer"]
    assert "不会重复执行" in result["answer"]
    assert "最近工作流: run-finished（completed" in _build_state_preamble(context)


def test_llm_disconnect_before_current_tool_does_not_report_previous_workflow():
    context = AgentContext(
        session_id="test-stale-workflow-disconnect",
        last_tool_result={
            "step_name": "sync_and_run_activity_workflow",
            "result": {
                "status": "completed",
                "workflow_id": "old-run",
                "sync": {"downloaded": 0, "skipped": 1},
                "tasks": [{"status": "skipped"}],
            },
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = LLMRequestError("connection closed before activation")
        result = run_tool_loop("重新同步一次，活动更新了", context=context)

    assert result["status"] == "llm_unavailable"
    assert result["executions"] == []
    assert "old-run" not in result["answer"]
    assert "本轮已执行 0 步" in result["answer"]


def test_max_steps_exceeded_returns_not_completed():
    context = AgentContext(session_id="test-max")
    response = {
        "id": "msg-loop",
        "content": [{"type": "tool_use", "name": "resolve_activities", "id": "tu-1", "input": {"kind": "recent", "limit": 1}}],
        "stop_reason": "tool_use",
    }
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        calls = {"count": 0}
        def respond(**kwargs):
            calls["count"] += 1
            return _activation_response("analyze-activity") if calls["count"] == 1 else response
        client.return_value.create_messages.side_effect = respond
        result = run_tool_loop("分析最近活动", context=context)

    assert result["status"] == "max_steps_exceeded"
    assert len(result["steps"]) == MAX_TOOL_STEPS


def test_resolve_activities_unblocks_analyze_activity_in_same_round(monkeypatch):
    context = AgentContext(session_id="test-find-then-analyze")
    calls: list[str] = []
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "resolve_activities", lambda args, ctx: calls.append("resolve_activities") or {"status": "completed"},
    )
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "analyze_activity", lambda args, ctx: calls.append("analyze_activity") or {"status": "completed"},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("analyze-activity"),
            {"id": "msg-tools", "content": [
                {"type": "tool_use", "name": "resolve_activities", "id": "tu-find", "input": {"kind": "recent", "limit": 1}},
                {"type": "tool_use", "name": "analyze_activity", "id": "tu-analyze", "input": {}},
            ], "stop_reason": "tool_use"},
            {"id": "msg-done", "content": [{"type": "text", "text": "分析完成"}], "stop_reason": "end_turn"},
        ]
        result = run_tool_loop("分析最后一个活动", context=context)

    assert result["status"] == "completed"
    assert calls == ["resolve_activities", "analyze_activity"]


def test_terminal_detail_query_returns_tool_answer_without_final_model_call(monkeypatch):
    context = AgentContext(
        session_id="terminal-detail",
        current_fit_file=Path("/tmp/current.fit"),
        selected_activities=[{"activity_key": "a1", "fit_path": "/tmp/current.fit"}],
    )
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "query_activity_detail",
        lambda args, ctx: {"status": "completed", "result": {"source": "targeted_query"}, "answer": "冲刺数据"},
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("analyze-activity"),
            {"id": "msg-query", "content": [{"type": "tool_use", "name": "query_activity_detail", "id": "tu-query", "input": {"question": "有冲刺吗"}}], "stop_reason": "tool_use"},
        ]
        result = run_tool_loop("这次有冲刺吗", context=context)

    assert result["status"] == "completed"
    assert result["steps"] == [{"tool": "query_activity_detail", "input": {"question": "有冲刺吗"}}]
    assert result["answer"].endswith("冲刺数据")
    assert client.return_value.create_messages.call_count == 2


def test_terminal_activity_report_replaces_pre_tool_commentary(monkeypatch):
    context = AgentContext(
        session_id="terminal-report-direct",
        current_fit_file=Path("/tmp/current.fit"),
        selected_activities=[{
            "activity_key": "a1", "fit_path": "/tmp/current.fit",
            "sport_type": "running", "start_time_local": "2026-08-19T18:40:15",
        }],
    )
    report = "# 跑步详细分析\n\n心率后程上升，步频整体稳定。"
    monkeypatch.setitem(
        __import__("agent.tools.registry", fromlist=["TOOL_HANDLERS"]).TOOL_HANDLERS,
        "analyze_activity",
        lambda args, ctx: {
            "step": "analyze_activity", "status": "completed", "answer": report,
            "result": {"source": "existing_report"},
        },
    )
    with patch("agent.main_agent.loop.AnthropicMessagesClient") as client:
        client.return_value.create_messages.side_effect = [
            _activation_response("analyze-activity"),
            {
                "id": "msg-report",
                "content": [
                    {"type": "text", "text": "I'll analyze the running activity."},
                    {"type": "tool_use", "name": "analyze_activity", "id": "tu-report", "input": {}},
                ],
                "stop_reason": "tool_use",
            },
        ]

        result = run_tool_loop("详细分析一下这个跑步活动", context=context)

    assert result["status"] == "completed"
    assert result["answer"].endswith(report)
    assert "I'll analyze" not in result["answer"]
    assert client.return_value.create_messages.call_count == 2
