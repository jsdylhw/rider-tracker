from agent.main_agent.context import AgentContext
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
