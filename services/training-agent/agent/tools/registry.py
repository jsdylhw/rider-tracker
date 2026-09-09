"""Canonical registry assembled from domain-owned Agent tool handlers."""

from __future__ import annotations

from typing import Any, Callable

from agent.main_agent.context import AgentContext
from agent.tools.handlers.activity_analysis import HANDLERS as ACTIVITY_ANALYSIS_HANDLERS
from agent.tools.handlers.activity_insights import HANDLERS as ACTIVITY_INSIGHT_HANDLERS
from agent.tools.handlers.activity_operations import HANDLERS as ACTIVITY_OPERATION_HANDLERS
from agent.tools.handlers.activity_reporting import HANDLERS as ACTIVITY_REPORTING_HANDLERS
from agent.tools.handlers.activity_selection import HANDLERS as ACTIVITY_SELECTION_HANDLERS
from agent.tools.handlers.activity_summary import HANDLERS as ACTIVITY_SUMMARY_HANDLERS
from agent.tools.handlers.control import HANDLERS as CONTROL_HANDLERS
from agent.tools.handlers.route import HANDLERS as ROUTE_HANDLERS


ToolHandler = Callable[[dict[str, Any], AgentContext], dict[str, Any]]


def _merge_handler_groups(*groups: dict[str, ToolHandler]) -> dict[str, ToolHandler]:
    merged: dict[str, ToolHandler] = {}
    for group in groups:
        duplicates = merged.keys() & group.keys()
        if duplicates:
            raise RuntimeError(f"duplicate tool handlers: {', '.join(sorted(duplicates))}")
        merged.update(group)
    return merged


TOOL_HANDLERS = _merge_handler_groups(
    CONTROL_HANDLERS,
    ACTIVITY_SELECTION_HANDLERS,
    ACTIVITY_ANALYSIS_HANDLERS,
    ACTIVITY_REPORTING_HANDLERS,
    ACTIVITY_SUMMARY_HANDLERS,
    ACTIVITY_INSIGHT_HANDLERS,
    ACTIVITY_OPERATION_HANDLERS,
    ROUTE_HANDLERS,
)


__all__ = ["TOOL_HANDLERS", "ToolHandler"]
