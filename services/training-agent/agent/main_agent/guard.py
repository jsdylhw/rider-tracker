"""Tool Guard — 运行时校验 LLM 工具调用的前置条件.

只做依赖/参数/合法性检查，不介入工具的副作用审批。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.main_agent.context import AgentContext

# 工具 → 前置依赖(context 中必须存在)
TOOL_DEPENDENCIES: dict[str, set[str]] = {
    "analyze_activity": {"selected_activities"},
    "query_activity_detail": {"selected_activities"},
    "find_segments": {"selected_activities"},
    "inspect_selection": {"selected_activities"},
    "analyze_selection": {"selected_activities"},
    "navigate_selection": {"selected_activities"},
    "summarize_activities": {"selected_activities"},
    "compare_activities": {"selected_activities"},
    "summarize_recent_training_load": {"selected_activities"},
    "calculate_history_metrics": {"selected_activities"},
    "analyze_training_history": {"selected_activities"},
    "generate_training_advice": {"selected_activities"},
}


@dataclass(frozen=True)
class GuardResult:
    allowed: bool
    reason: str = ""


def guard_tool_call(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    context: AgentContext,
    allowed_categories: set[str],
    allowed_tool_names: set[str] | None = None,
    has_resolved: bool = False,
) -> GuardResult:
    """校验工具调用的前置条件.

    - 工具白名单: 只能调用当前 Skill 明确允许的已注册 Main Agent 工具
    - 依赖检查: analyze 需要 selected_activities
    - 参数检查: sync count 范围
    - 不涉及副作用审批
    """
    category = _tool_category(tool_name)
    if category is None:
        return GuardResult(allowed=False, reason=f"未知或未注册工具: {tool_name}")
    if allowed_tool_names is not None and tool_name not in allowed_tool_names:
        return GuardResult(allowed=False, reason=f"{tool_name} 不属于当前激活 Skill")
    if category not in allowed_categories:
        return GuardResult(allowed=False, reason=f"{tool_name} 不在本轮允许的工具类别中")

    # 依赖检查
    deps = TOOL_DEPENDENCIES.get(tool_name, set())
    if "selected_activities" in deps and not has_resolved:
        return GuardResult(
            allowed=False,
            reason=f"{tool_name} 需要先定位活动,当前无选中活动",
        )

    # 参数检查
    if tool_name in {"sync_garmin_activities", "sync_and_run_activity_workflow"}:
        count = arguments.get("count", 5)
        if isinstance(count, (int, float)) and (count <= 0 or count > 20):
            return GuardResult(allowed=False, reason="count 必须在 1-20 之间")

    return GuardResult(allowed=True)


def _tool_category(tool_name: str) -> str | None:
    """从唯一的 Main Agent 工具目录查询类别，避免依赖可变 handler 表。"""
    from agent.tools.agent_tools import MAIN_AGENT_TOOLS

    for tool in MAIN_AGENT_TOOLS:
        if tool.name == tool_name:
            return tool.category
    return None
