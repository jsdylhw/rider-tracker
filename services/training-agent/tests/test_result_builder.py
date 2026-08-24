from agent.main_agent.context import AgentContext
from agent.main_agent.result_builder import with_execution_header


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
