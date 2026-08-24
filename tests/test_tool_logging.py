from agent.main_agent.hooks import _format_tool_args, _summarize_output
from agent.runtime.chat_logger import write_main_agent_markdown_log


def test_tool_logging_uses_business_labels_for_morning_range_summary():
    find_block = {"name": "resolve_activities", "input": {"kind": "recent", "limit": 3, "time_of_day": "morning"}}

    assert _format_tool_args(find_block) == "最近活动 · 3 条 · 上午"
    assert _format_tool_args({"name": "summarize_activities", "input": {}}) == "只读汇总结构化事实和已有报告"
    assert _format_tool_args({"name": "calculate_history_metrics", "input": {"group_by": "month"}}) == "读取结构化指标 · 按 month 聚合"
    assert _format_tool_args({"name": "analyze_training_history", "input": {"group_by": "week", "sport_type": "cycling"}}) == "专业历史分析 · cycling · 按 week 对比"


def test_tool_logging_renders_explicit_date_scope():
    block = {"name": "resolve_activities", "input": {"kind": "date", "date": "today", "time_of_day": "morning", "sport_type": "Ride"}}

    assert _format_tool_args(block) == "指定日期 · 上午 · 今天 · Ride"


def test_tool_logging_distinguishes_an_auxiliary_oldest_lookup():
    block = {"name": "lookup_activities", "input": {"kind": "all", "order": "earliest", "limit": 1}}

    assert _format_tool_args(block) == "全库最早活动 · 1 条"


def test_tool_logging_renders_longest_activity_scope():
    block = {"name": "resolve_activities", "input": {"kind": "all", "order": "longest", "limit": 1}}

    assert _format_tool_args(block) == "全库最长活动 · 1 条"


def test_tool_logging_identifies_report_source_and_activities():
    find_output = {
        "result": {
            "count": 1,
            "activities": [{"start_time_local": "2026-05-19T08:00:00", "file_name": "morning.fit"}],
        }
    }
    assert _summarize_output("resolve_activities", find_output) == "找到 1 条活动：2026-05-19T08:00:00 morning.fit"
    assert _summarize_output("analyze_activity", {"result": {"source": "existing_summary"}}) == "已读取已有报告"


def test_markdown_log_records_status_result_and_navigation_transition(tmp_path):
    path = write_main_agent_markdown_log(
        "navigation-trace",
        user_message="查看最近五条中的第二条，再看最老活动",
        tool_plan={"intent": "analyze_single", "tool_groups": ["manage-activity-library"]},
        execution={"step_results": [{
            "index": 0,
            "tool": "resolve_activities",
            "input": {"kind": "recent", "limit": 5},
            "status": "completed",
            "result": {"result": {"count": 5}},
            "navigation_before": {"root_type": None, "root_count": 0, "focus_type": None},
            "navigation_after": {"root_type": "activity_set", "root_count": 5, "focus_type": "activity_set", "depth": 1},
        }]},
        selected_activities=[],
        selected_activity_range=None,
        current_fit_file=None,
        log_dir=tmp_path,
    )

    text = path.read_text(encoding="utf-8")
    assert "- status: `completed`" in text
    assert "- count: `5`" in text
    assert "- navigation:" in text
