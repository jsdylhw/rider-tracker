"""Deterministic per-turn capability rules applied after Skill activation."""

from __future__ import annotations

import re

from agent.main_agent.tool_result import is_failed_tool_output


_TIME_WINDOW_RE = re.compile(
    r"(?:\d+|[一二三四五六七八九十]+)\s*(?:-|–|—|到|至|~)\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:秒|s\b|分钟|min\b|分\b)"
    r"|(?:前|后|最后|开始后)\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:秒|s\b|分钟|min\b|分\b)",
    re.IGNORECASE,
)
_DISTANCE_WINDOW_RE = re.compile(
    r"(?:\d+(?:\.\d+)?|[一二三四五六七八九十]+)\s*(?:-|–|—|到|至|~)\s*"
    r"(?:\d+(?:\.\d+)?|[一二三四五六七八九十]+)\s*(?:公里|km\b|千米|米\b)"
    r"|(?:前|后|最后)\s*\d+(?:\.\d+)?\s*(?:公里|km\b|千米|米\b)",
    re.IGNORECASE,
)

_ROUTE_FOLLOWUP_ACTION_RE = re.compile(
    r"(?:增加|加入|添加|插入|删除|去掉|移除|替换|改成|改为|改走|绕开|避开|"
    r"反转|倒过来|调换|缩短|延长|确认|保存|撤销|预览|选择|选中)"
)
_ROUTE_REFERENCE_RE = re.compile(
    r"(?:当前路线|这条路线|路线|候选|途经|点位|锚点|起点|终点|路段|第[一二两三四五六七八九十\d]+条|→|->)"
)


def requires_raw_window_evidence(message: str) -> bool:
    """Whether the user explicitly requested a bounded raw FIT window."""
    text = str(message or "")
    return bool(_TIME_WINDOW_RE.search(text) or _DISTANCE_WINDOW_RE.search(text))


def tools_for_skill(skill, message: str) -> set[str]:
    """Return the exact tool surface for one activated Skill and user turn."""
    names = set(skill.tool_names) if skill else set()
    if skill and skill.skill_id == "analyze-activity" and requires_raw_window_evidence(message):
        names.discard("find_segments")
        names.discard("analyze_selection")
        names.discard("analyze_activity")
    return names


def should_continue_route_skill(message: str, context) -> bool:
    """Reuse route capability only for an explicit edit of a persisted route."""
    recent = [str(value) for value in getattr(context, "last_used_skills", []) if str(value)]
    if not recent or recent[-1] != "plan-routes":
        return False
    if not getattr(context, "workspace_id", None):
        return False
    text = str(message or "").strip()
    if not (_ROUTE_FOLLOWUP_ACTION_RE.search(text) and _ROUTE_REFERENCE_RE.search(text)):
        return False
    from storage.repositories.route import RoutePlanStore

    return RoutePlanStore().get_latest(str(context.workspace_id)) is not None


def activation_note(skill_id: str, message: str) -> str:
    """Return bounded dynamic instructions that depend on the original turn."""
    if skill_id == "analyze-activity" and requires_raw_window_evidence(message):
        return (
            "本轮请求包含明确的时间或距离窗口。完成活动定位后，必须调用 "
            "query_activity_detail 并把原问题原样传入；不得只根据预计算候选片段下结论。"
        )
    return ""


def is_terminal_tool_result(name: str, output: object) -> bool:
    """Whether a successful tool result closes the business-tool phase."""
    terminal_tools = {
        "analyze_activity", "query_activity_detail", "summarize_activities",
        "compare_activities", "generate_training_advice", "summarize_recent_training_load",
        "calculate_history_metrics", "analyze_training_history", "inspect_selection",
        "analyze_selection", "create_route_plan", "create_itinerary_plan",
        "update_route_plan", "get_route_plan", "explore_route_segments", "sync_garmin_activities",
        "sync_and_run_activity_workflow", "run_activity_workflow", "get_activity_workflow",
        "retry_activity_workflow", "rebuild_activity_reports", "get_activity_report_job", "cancel_activity_report_job",
    }
    if name not in terminal_tools:
        return False
    if not isinstance(output, dict) or output.get("error") or is_failed_tool_output(output):
        return False
    side_effect_tools = {
        "sync_garmin_activities", "sync_and_run_activity_workflow", "run_activity_workflow",
        "get_activity_workflow", "retry_activity_workflow", "rebuild_activity_reports",
        "get_activity_report_job", "cancel_activity_report_job",
    }
    if name in side_effect_tools:
        return output.get("status") not in {None, "failed", "busy", "not_found"}
    return output.get("status") == "completed"
