from agent.main_agent.context import AgentContext
from agent.main_agent.execution_policy import TurnExecutionPolicy
from unittest.mock import patch
from agent.main_agent.result_builder import build_completed_result, build_turn_result, with_execution_header


def test_execution_header_does_not_expose_internal_activity_key():
    context = AgentContext(
        session_id="header-test",
        selected_activities=[{"activity_key": "51ae1234private"}],
    )

    answer = with_execution_header(
        "分析完成。",
        context=context,
        steps=[{"tool": "inspect_selection"}],
    )

    assert answer.startswith("已处理：当前活动｜初步检查")
    assert "51ae1234private" not in answer


def test_execution_header_replaces_model_generated_internal_header():
    context = AgentContext(
        session_id="header-test",
        selected_activities=[{"activity_key": "51ae1234private"}],
    )

    answer = with_execution_header(
        "已处理：活动 51ae1234private｜完整报告\n\n正文结论。",
        context=context,
        steps=[{"tool": "analyze_activity"}],
    )

    assert answer == "已处理：当前活动｜读取活动报告\n\n正文结论。"


def test_partial_workflow_uses_deterministic_error_answer(monkeypatch, tmp_path):
    context = AgentContext(
        session_id="partial-workflow",
        selected_activities=[{
            "activity_key": "latest", "start_time_local": "2026-08-24T08:33:28",
            "summary_label": "短程骑行",
        }],
    )
    context.execution_trace.append({
        "tool": "run_activity_workflow",
        "status": "partial",
        "result": {
            "status": "partial", "workflow_id": "run-partial",
            "answer": "处理部分完成：2026-08-24T08:33:28 短程骑行。\n- Strava 上传失败：TLS EOF。",
        },
    })
    monkeypatch.setattr(
        "agent.main_agent.result_builder.write_main_agent_markdown_log",
        lambda *args, **kwargs: tmp_path / "turn.md",
    )

    result = build_completed_result(
        "mixed", context, "分析最后一个活动然后上传 Strava",
        step_count=1, max_tool_steps=8,
        steps=[{"tool": "run_activity_workflow", "input": {"limit": 1}}],
    )

    assert "处理部分完成" in result["answer"]
    assert "Strava 上传失败：TLS EOF" in result["answer"]
    assert "已完成。" not in result["answer"]


def test_route_turn_exposes_route_plan_view(monkeypatch):
    context = AgentContext(session_id="route-turn")
    context.execution_trace.append({
        "tool": "create_route_plan",
        "status": "completed",
        "result": {"result": {"plan_id": "route-1"}},
    })
    monkeypatch.setattr(
        "agent.main_agent.result_builder.RoutePlanStore.get",
        lambda self, plan_id: {
            "plan_id": plan_id,
            "revision": 2,
            "candidates": [{"candidate_id": "candidate-1"}],
        },
    )

    result = build_turn_result("completed", "route_advice", context, [], "完成")

    assert result["route_plan"]["schema_version"] == "route_plan_view.v1"
    assert result["route_plan"]["plan_id"] == "route-1"
    assert result["route_plan"]["revision"] == 2


def test_route_turn_uses_the_last_route_execution_when_multiple_plans_exist(monkeypatch):
    context = AgentContext(session_id="route-turn")
    context.execution_trace.extend([
        {
            "tool": "create_route_plan",
            "status": "completed",
            "result": {"result": {"plan_id": "route-old"}},
        },
        {
            "tool": "inspect_selection",
            "status": "completed",
            "result": {"answer": "non-route execution"},
        },
        {
            "tool": "update_route_plan",
            "status": "completed",
            "result": {"result": {"plan_id": "route-new"}},
        },
    ])
    plans = {
        "route-old": {
            "plan_id": "route-old", "revision": 1,
            "candidates": [{"candidate_id": "candidate-old"}],
        },
        "route-new": {
            "plan_id": "route-new", "revision": 3,
            "candidates": [{"candidate_id": "candidate-new"}],
        },
    }
    monkeypatch.setattr(
        "agent.main_agent.result_builder.RoutePlanStore.get",
        lambda self, plan_id: plans.get(plan_id),
    )

    result = build_turn_result("completed", "route_advice", context, [], "完成")

    assert result["route_plan"]["plan_id"] == "route-new"
    assert result["route_plan"]["revision"] == 3


def test_route_turn_fails_closed_when_route_tool_did_not_succeed():
    context = AgentContext(
        session_id="failed-route-turn",
        workspace_id="workspace",
        active_skill_id="plan-routes",
        route_request_options={"include_elevation": False},
        messages=[{
            "role": "assistant",
            "content": [{"type": "text", "text": "本轮三条候选全部被拒。"}],
        }],
    )
    context.execution_trace.append({
        "tool": "create_route_plan",
        "status": "failed",
        "error": "Google route request timed out",
        "result": {
            "status": "failed",
            "error": "Google route request timed out",
            "result": {"plan_id": "stale-route"},
        },
    })

    result = build_completed_result(
        "route_advice",
        context,
        "规划一条京都 30 km 环线",
        step_count=1,
        max_tool_steps=8,
        steps=[{"tool": "create_route_plan", "input": {}}],
        execution_policy=TurnExecutionPolicy.route_plan("create"),
    )

    assert result["status"] == "tool_failed"
    assert "本轮三条候选全部被拒" not in result["answer"]
    assert result["error"]["code"] == "tool_failed"
    assert result["executions"][0]["status"] == "failed"
    assert "route_plan" not in result


def test_route_turn_without_success_preserves_budget_exhaustion():
    context = AgentContext(
        session_id="route-max-steps",
        active_skill_id="plan-routes",
        route_request_options={"include_elevation": False},
    )

    result = build_completed_result(
        "route_advice",
        context,
        "规划一条京都 30 km 环线",
        step_count=11,
        max_tool_steps=10,
        steps=[],
        execution_policy=TurnExecutionPolicy.route_plan("create"),
    )

    assert result["status"] == "max_steps_exceeded"
    assert result["error"]["code"] == "budget_exhausted"
    assert "达到最大步数" in result["answer"]


def test_public_error_projection_excludes_internal_details():
    from agent.runtime.models import public_turn_dict

    result = public_turn_dict({
        "status": "blocked", "answer": "拒绝调用",
        "error": {
            "code": "guard_rejected", "stage": "guard", "retryable": False,
            "message": "拒绝调用", "input": {"secret": "private"}, "traceback": "private",
        },
    })
    assert result["error"] == {
        "code": "guard_rejected", "stage": "guard", "retryable": False, "message": "拒绝调用",
    }
    assert "provider" not in result["error"]


def test_preparation_success_does_not_hide_analysis_failure():
    context = AgentContext(session_id="preparation-failure")
    context.execution_trace = [
        {"tool": "resolve_activities", "status": "completed", "result": {"status": "completed"}},
        {"tool": "analyze_activity", "status": "failed", "result": {"status": "failed"}},
    ]
    result = build_completed_result("analysis", context, "分析", step_count=2, max_tool_steps=10, steps=[])
    assert result["status"] == "tool_failed"
    assert result["error"]["code"] == "tool_failed"


def test_status_only_and_nested_failures_are_executed_failures():
    for payload in [
        {"status": "failed", "answer": "上传任务失败", "tasks": [{"status": "failed"}]},
        {"result": {"error": "network_failure", "message": "上传网络失败"}},
    ]:
        context = AgentContext(session_id="workflow-failure")
        context.execution_trace = [{"tool": "run_activity_workflow", "status": "failed", "result": payload}]
        result = build_completed_result("workflow", context, "上传", step_count=1, max_tool_steps=10, steps=[])
        assert result["status"] == "tool_failed"
        assert result["error"]["code"] == "tool_failed"
        assert "上传" in result["error"]["message"]


def test_nonrequired_guard_rejection_remains_public():
    context = AgentContext(session_id="refine-blocked")
    context.execution_trace = [{
        "tool": "get_route_plan", "status": "blocked",
        "result": {"code": "guard_rejected", "message": "工具不在白名单", "retryable": False},
    }]
    result = build_completed_result(
        "route_advice", context, "修改", step_count=1, max_tool_steps=10, steps=[],
        execution_policy=TurnExecutionPolicy.route_plan("refine"),
    )
    assert result["status"] == "blocked"
    assert result["error"]["message"] == "工具不在白名单"
    assert "provider" not in result["error"]


def test_successful_same_target_replay_recovers_but_other_target_does_not():
    for target, expected in [("a", "completed"), ("b", "tool_failed")]:
        context = AgentContext(session_id="recovered-analysis")
        context.execution_trace = [
            {"tool": "analyze_activity", "input": {"activity_key": "a"}, "status": "failed", "result": {"status": "failed"}},
            {"tool": "analyze_activity", "input": {"activity_key": target}, "status": "completed", "result": {"status": "completed", "answer": "分析完成"}},
        ]
        with patch("agent.main_agent.result_builder.write_main_agent_markdown_log", return_value=""):
            result = build_completed_result("analysis", context, "分析", step_count=2, max_tool_steps=10, steps=[])
        assert result["status"] == expected


def test_activity_resolution_is_not_publication_evidence():
    context = AgentContext(session_id='selection-only', active_skill_id='publish-to-strava',
                           messages=[{'role': 'user', 'content': '上传这条'},
                                     {'role': 'assistant', 'content': [{'type': 'text', 'text': '已经上传成功'}]}])
    context.execution_trace = [{'tool': 'resolve_activities', 'status': 'completed',
                                'result': {'status': 'completed', 'activities': [{'activity_key': 'a'}]}}]
    result = build_completed_result('upload', context, '上传这条', step_count=2,
                                    max_tool_steps=10, steps=[{'tool': 'resolve_activities'}])
    assert result['status'] == 'action_not_executed'
    assert '上传成功' not in result['answer']
