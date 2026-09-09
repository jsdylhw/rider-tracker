"""Agent adapter for explicit, typed activity resolution."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from agent.main_agent.context import AgentContext
from domain.activity.models import ActivityHandle
from domain.activity.selection import ActivitySelectionRequest
from services.activity.resolver import ActivityResolver


def resolve_activities(
    arguments: dict[str, Any],
    context: AgentContext,
    *,
    path: str | Path | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    """Validate, resolve and atomically install one activity selection.

    The resolver itself is pure.  This adapter is the sole place that mutates
    the chat context and persisted navigation after a successful lookup.
    """
    try:
        request = ActivitySelectionRequest.from_arguments(arguments)
        current_ids = [
            str(item.get("activity_key") or "")
            for item in context.selected_activities
            if isinstance(item, dict) and item.get("activity_key")
        ]
        selection = ActivityResolver(path).resolve(
            request,
            today=today,
            current_activity_ids=current_ids,
        )
    except ValueError as exc:
        return {
            "step": "resolve_activities",
            "status": "failed",
            "error": "invalid_activity_selection",
            "message": str(exc),
        }

    result = selection.to_dict()
    activities = result["activities"]
    if request.kind == "current":
        # Reading the current focus must not replace the frozen navigation
        # root; otherwise a later `back` can no longer return to its set.
        return {
            "step": "resolve_activities",
            "status": "completed",
            "result": result,
        }
    if activities:
        handles = [ActivityHandle.from_index_entry(item) for item in activities]
        context.set_selected_activities(handles, scope=result["request"])
    else:
        # A new successful query that finds nothing must not leave a stale
        # prior activity available to downstream analysis tools.
        context.clear_activities()

    from agent.tools.handlers.activity_analysis import record_activity_selection

    record_activity_selection(context, path=path)

    return {
        "step": "resolve_activities",
        "status": "completed",
        "result": result,
    }


def lookup_activities(
    arguments: dict[str, Any],
    context: AgentContext,
    *,
    path: str | Path | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    """Resolve an auxiliary catalogue query without changing navigation.

    A compound user request can refer to an established collection and an
    independent activity at the same time.  Unlike ``resolve_activities``,
    this read-only lookup must not replace the persisted root or current focus.
    """
    try:
        request = ActivitySelectionRequest.from_arguments(arguments)
        current_ids = [
            str(item.get("activity_key") or "")
            for item in context.selected_activities
            if isinstance(item, dict) and item.get("activity_key")
        ]
        selection = ActivityResolver(path).resolve(
            request,
            today=today,
            current_activity_ids=current_ids,
        )
    except ValueError as exc:
        return {
            "step": "lookup_activities",
            "status": "failed",
            "error": "invalid_activity_selection",
            "message": str(exc),
        }

    return {
        "step": "lookup_activities",
        "status": "completed",
        "result": selection.to_dict(),
        "navigation_changed": False,
    }


HANDLERS = {
    "resolve_activities": resolve_activities,
    "lookup_activities": lookup_activities,
}
