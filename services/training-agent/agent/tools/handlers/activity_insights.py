"""Thin Agent adapters for deterministic multi-activity services."""

from __future__ import annotations

from typing import Any

from agent.main_agent.context import AgentContext
from services.activity.comparison import compare_activities as compare_activity_facts
from services.activity.history import calculate_history_metrics as calculate_history_metrics_service
from services.activity.training_history_analysis import analyze_training_history as analyze_training_history_service
from services.activity.training_load import summarize_training_load


def compare_selected_activities_tool(
    context: AgentContext,
    *,
    name: str = "compare_activities",
) -> dict[str, Any]:
    """Pass the current concrete selection to the comparison service."""
    return compare_activity_facts(
        [item for item in context.selected_activities if isinstance(item, dict)],
        name=name,
    )


def calculate_history_metrics_tool(
    context: AgentContext,
    *,
    group_by: str = "week",
    name: str = "calculate_history_metrics",
) -> dict[str, Any]:
    """Pass selected activities and their frozen scope to history aggregation."""
    return calculate_history_metrics_service(
        context.selected_activities,
        scope=context.selected_activity_range,
        group_by=group_by,
        name=name,
    )


def summarize_recent_training_load_tool(
    context: AgentContext,
    *,
    name: str = "summarize_recent_training_load",
) -> dict[str, Any]:
    """Pass selected activities to the deterministic load service."""
    return summarize_training_load(
        context.selected_activities,
        scope=context.selected_activity_range,
        name=name,
    )


def analyze_training_history_tool(
    context: AgentContext,
    *,
    group_by: str = "week",
    sport_type: str | None = None,
    combine_sports_for_volume: bool = False,
    name: str = "analyze_training_history",
) -> dict[str, Any]:
    """Build the professional history artifact from the frozen selection."""
    return analyze_training_history_service(
        context.selected_activities,
        scope=context.selected_activity_range,
        group_by=group_by,
        sport_type=sport_type,
        combine_sports_for_volume=combine_sports_for_volume,
        name=name,
    )


def compare_activities(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return compare_selected_activities_tool(context, name="compare_activities")


def summarize_recent_training_load(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return summarize_recent_training_load_tool(context, name="summarize_recent_training_load")


def calculate_history_metrics(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return calculate_history_metrics_tool(
        context,
        group_by=str(args.get("group_by") or "week"),
        name="calculate_history_metrics",
    )


def analyze_training_history(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return analyze_training_history_tool(
        context,
        group_by=str(args.get("group_by") or "week"),
        sport_type=str(args.get("sport_type") or "") or None,
        combine_sports_for_volume=bool(args.get("combine_sports_for_volume")),
        name="analyze_training_history",
    )


HANDLERS = {
    "compare_activities": compare_activities,
    "summarize_recent_training_load": summarize_recent_training_load,
    "calculate_history_metrics": calculate_history_metrics,
    "analyze_training_history": analyze_training_history,
}
