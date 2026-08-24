"""Deterministic control turns that must mutate durable runtime state."""

from __future__ import annotations

import re
from typing import Any

from agent.main_agent.context import AgentContext
from agent.main_agent.saved_action import execute_saved_action
from agent.tools.registry import TOOL_HANDLERS
from agent.skills import get_skill, skill_allows_tool
from agent.runtime.models import ToolExecution, TurnResult

RETRY_WORDS = {"再试一次", "重试", "再试", "retry", "try again", "再来一次", "重新试一下"}
BACK_WORDS = {"返回", "回退", "上一层", "返回上一层", "回到列表", "返回列表", "back"}
ROOT_WORDS = {"回到最初", "回到根范围", "返回根范围", "回到最初范围", "root"}

# These suffixes only constrain presentation.  They do not add a domain
# analysis objective, so the ordinal selection can still be performed by the
# deterministic navigation layer instead of trusting the model to mutate it.
_NAVIGATION_ONLY_SUFFIXES = {
    "只看概览",
    "只查看概览",
    "只看轻量概览",
    "只查看轻量概览",
    "不生成报告",
    "只看概览不生成报告",
    "只查看概览不生成报告",
    "只看轻量概览不生成报告",
    "只查看轻量概览不生成报告",
}


def handle_control_turn(message: str, context: AgentContext, *, verbose: bool = False) -> dict[str, Any] | None:
    """Handle short control replies before routing the message through the LLM."""
    navigation = _navigation_command(message, context)
    if navigation is not None:
        action, ordinal = navigation
        return _execute_navigation(action, ordinal, context, verbose=verbose)

    if is_retry(message):
        if context.last_failed_action:
            tool_name = str(context.last_failed_action.get("tool") or "")
            skill = get_skill(context.active_skill_id)
            if not skill_allows_tool(skill, tool_name):
                answer = "上次失败操作不属于当前有效 Skill，已拒绝直接重放。请重新说明要重试的活动任务。"
                context.last_failed_action = None
                return TurnResult(
                    answer=answer, status="retry_rejected", context=context,
                    intent="retry", skill_id=context.active_skill_id,
                    selected_activities=context.selected_activities,
                    current_fit_file=str(context.current_fit_file) if context.current_fit_file else None,
                ).to_dict()
            return execute_saved_action(context.last_failed_action, context, verbose=verbose, intent="retry", label="重试执行")
        if context.last_llm_error:
            # 不复放可能有副作用的工具，只重新进入 LLM 规划循环；已完成的
            # 工具状态仍由 context 和状态 preamble 提供。
            context.last_llm_error = None
            return None
        answer = "当前没有可重试的失败操作。请重新说明你想执行的操作。"
        context.messages.append({"role": "assistant", "content": [{"type": "text", "text": answer}]})
        return TurnResult(
            answer=answer, status="no_retryable_action", context=context,
            intent="retry", skill_id=context.active_skill_id,
            selected_activities=context.selected_activities,
            current_fit_file=str(context.current_fit_file) if context.current_fit_file else None,
        ).to_dict()

    return None


def is_retry(message: str) -> bool:
    return message.lower().strip() in RETRY_WORDS


def _navigation_command(message: str, context: AgentContext) -> tuple[str, int | None] | None:
    """Recognize only short, unambiguous navigation commands.

    Longer requests such as “分析第二个活动的心率” still go through Skill
    selection because they contain a domain objective in addition to movement.
    """
    normalized = re.sub(r"[\s，。！？,.!?]+", "", str(message or "").strip().lower())
    navigation = context.analysis_navigation if isinstance(context.analysis_navigation, dict) else {}
    stack = list(navigation.get("focus_stack") or [])
    if not stack:
        return None
    if normalized in BACK_WORDS:
        return "back", None
    if normalized in ROOT_WORDS:
        return "root", None

    match = re.fullmatch(
        r"(?:看|查看|选择|选中|打开|进入)?"
        r"第([一二两三四五六七八九十]|\d+)个(?:活动|片段)?(.*)",
        normalized,
    )
    if not match:
        return None
    suffix = match.group(2)
    if suffix and suffix not in _NAVIGATION_ONLY_SUFFIXES:
        return None
    ordinal = _ordinal(match.group(1))
    return ("select", ordinal) if ordinal is not None else None


def _execute_navigation(
    action: str,
    ordinal: int | None,
    context: AgentContext,
    *,
    verbose: bool,
) -> dict[str, Any]:
    """Move the persisted focus and return a deterministic visible result."""
    tool_input = {"action": action}
    if ordinal is not None:
        tool_input["ordinal"] = ordinal
    output = TOOL_HANDLERS["navigate_selection"](tool_input, context)
    failed = bool(output.get("error")) if isinstance(output, dict) else True
    if failed:
        answer = str(output.get("message") or "无法完成导航。")
        status = "navigation_failed"
    else:
        answer = _navigation_answer(action, ordinal, context)
        status = "completed"

    context.last_tool_result = {"step_name": "navigate_selection", "result": output}
    execution = ToolExecution(
        index=0,
        tool="navigate_selection",
        input=tool_input,
        status="failed" if failed else "completed",
        message=str(output.get("message")) if isinstance(output, dict) and output.get("message") else None,
        error=str(output.get("error")) if isinstance(output, dict) and output.get("error") else None,
        result=output,
    )
    context.execution_trace = [execution.to_dict()]
    context.messages.append({"role": "assistant", "content": [{"type": "text", "text": answer}]})
    if verbose:
        from agent.main_agent.hooks import _log

        suffix = f" · 第 {ordinal} 个" if ordinal is not None else ""
        _log(f"  [导航] navigate_selection：{action}{suffix}")
    return TurnResult(
        answer=answer, status=status, context=context, intent="navigate",
        skill_id=context.active_skill_id, executions=[execution],
        selected_activities=context.selected_activities,
        current_fit_file=str(context.current_fit_file) if context.current_fit_file else None,
    ).to_dict()


def _navigation_answer(action: str, ordinal: int | None, context: AgentContext) -> str:
    activities = [item for item in context.selected_activities if isinstance(item, dict)]
    if len(activities) == 1:
        activity = activities[0]
        started = activity.get("start_time_local") or activity.get("date_local") or "时间未知"
        label = activity.get("summary_label") or activity.get("file_name") or activity.get("activity_key")
        prefix = f"已切换到第 {ordinal} 条活动" if action == "select" else "当前活动"
        return f"{prefix}：{started} {label}。后续的“这个活动”将指向该活动。"
    if activities:
        return f"已返回活动集合，共 {len(activities)} 条；后续可以按序号选择或进行整体分析。"
    return "当前没有可用的活动导航焦点。"


def _ordinal(value: str) -> int | None:
    if value.isdigit():
        return int(value)
    return {
        "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
        "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    }.get(value)
