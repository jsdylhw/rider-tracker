"""Agent-facing adapters for activity analysis services and navigation."""

from __future__ import annotations

from typing import Any

from agent.main_agent.context import AgentContext
from agent.analysis.workspace import AnalysisNavigationService
from domain.analysis.models import AnalysisRequest
from domain.contracts.schemas import ANALYSIS_RESULT_V1
from services.activity.analysis import analyze_resolved_target, discover_activity_segments
from storage.repositories.analysis import AnalysisStore


def record_activity_selection(context: AgentContext, *, path=None) -> dict[str, Any]:
    """Persist a successful resolver result as the current navigation root."""
    activities = [item for item in context.selected_activities if isinstance(item, dict)]
    return AnalysisNavigationService(path).replace_activities(
        context,
        activities,
        scope=context.selected_activity_range,
    )


def find_segments(arguments: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    """Resolve semantic segments inside the current single activity."""
    navigation = AnalysisNavigationService()
    activity_ids = navigation.nearest_activity_ids(context)
    if len(activity_ids) != 1:
        return {
            "error": "single_activity_required",
            "message": "find_segments requires one current activity; select an activity first.",
            "selected_count": len(activity_ids),
        }
    result = discover_activity_segments(activity_ids[0], arguments)
    if result.get("error"):
        return result
    segments = result.get("segments") if isinstance(result.get("segments"), list) else []
    ordinal = result.get("selected_ordinal")
    # Empty discovery must not erase a valid activity focus used by follow-ups.
    if segments:
        navigation.push_segments(context, segments, selected_ordinal=ordinal)
    return {"step": "find_segments", "status": "completed", "result": result}


def inspect_selection(arguments: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    """Inspect the current focus using the cheapest deterministic facts."""
    request = AnalysisRequest.from_arguments(
        {**arguments, "objective": "inspect_activity", "depth": "inspect"},
    )
    return _execute_and_store(request, context)


def analyze_selection(arguments: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    """Translate the bounded request contract into a service invocation."""
    try:
        request = AnalysisRequest.from_arguments(arguments)
    except ValueError as exc:
        return {"error": "invalid_analysis_request", "message": str(exc)}
    return _execute_and_store(request, context)


def navigate_selection(arguments: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    """Move the current focus without resolving the original user phrase again."""
    try:
        navigation = AnalysisNavigationService().navigate(
            context,
            action=str(arguments.get("action") or "current"),
            ordinal=arguments.get("ordinal"),
        )
    except ValueError as exc:
        message = str(exc)
        if message.startswith("ordinal must be between 1 and 0"):
            message = "当前焦点是单条活动，不存在可按序号选择的活动集合。请先定位一个活动集合。"
        return {"error": "invalid_navigation", "message": message}
    return {
        "step": "navigate_selection",
        "status": "completed",
        "result": {
            "kind": "analysis_navigation_result",
            "workspace_id": navigation.get("workspace_id"),
            "current_focus": (navigation.get("focus_stack") or [None])[-1],
            "root_scope": navigation.get("root_scope"),
            "depth": len(navigation.get("focus_stack") or []),
        },
    }


def _execute_and_store(request: AnalysisRequest, context: AgentContext) -> dict[str, Any]:
    """Resolve navigation, invoke the service, then persist the artifact."""
    navigation = AnalysisNavigationService()
    service_result = analyze_resolved_target(
        request,
        activity_ids=navigation.nearest_activity_ids(context),
        segments_raw=navigation.current_segments(context),
        focused_analyzer=_focused_analyzer,
    )
    if service_result.get("error"):
        return service_result

    workspace_id = context.workspace_id or "default"
    analysis = service_result.get("analysis") if isinstance(service_result.get("analysis"), dict) else {}
    stored = AnalysisStore().save_result(
        workspace_id=workspace_id,
        request=service_result.get("request") or {},
        target=service_result.get("target") or {},
        result=analysis,
        status=str(service_result.get("status") or "completed"),
    )
    navigation.set_last_result(context, stored["id"])
    payload = {
        "schema_version": ANALYSIS_RESULT_V1,
        "result_id": stored["id"],
        "workspace_id": workspace_id,
        "request": service_result.get("request") or {},
        "target": service_result.get("target") or {},
        "analysis": analysis,
    }
    return {
        "step": "inspect_selection" if request.objective == "inspect_activity" else "analyze_selection",
        "status": str(service_result.get("status") or "completed"),
        "result": payload,
        **({"answer": analysis["answer"]} if isinstance(analysis.get("answer"), str) else {}),
    }


def _focused_analyzer(activity: dict[str, Any], question: str) -> dict[str, Any]:
    """Inject the LLM-backed child agent only at the Agent adapter boundary."""
    from agent.tools.handlers.activity_reporting import answer_focused_activity_question

    return answer_focused_activity_question(activity, question=question)


HANDLERS = {
    "find_segments": find_segments,
    "inspect_selection": inspect_selection,
    "analyze_selection": analyze_selection,
    "navigate_selection": navigate_selection,
}
