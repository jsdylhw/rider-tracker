"""Agent adapters for side-effecting activity operations."""

from __future__ import annotations

from typing import Any

from agent.main_agent.context import AgentContext
from domain.activity.models import ActivityHandle
from storage.repositories.activity import ActivityStore


def sync_garmin_activities(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    from operations.activity.sync import sync_recent

    result = sync_recent(
        count=int(args.get("count", 5)),
        force_download=bool(args.get("force_download")),
    )
    _install_activity_selection(result, context, scope_type="garmin_sync_result")
    return result


def sync_and_run_activity_workflow(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    from operations.activity.workflow_service import sync_and_start_activity_workflow

    result = sync_and_start_activity_workflow(
        count=int(args.get("count", 5)),
        goals=args.get("goals") or ("ensure_summary",),
        force=bool(args.get("force")),
        force_download=bool(args.get("force_download")),
        force_upload=bool(args.get("force_upload")),
    )
    _install_activity_selection(result, context, scope_type="garmin_sync_result")
    return result


def _install_activity_selection(
    result: dict[str, Any],
    context: AgentContext,
    *,
    scope_type: str,
) -> None:
    """Make follow-up references point at this workflow, never an older FIT."""
    rows = [item for item in result.get("activities") or [] if isinstance(item, dict)]
    handles: list[ActivityHandle] = []
    store = ActivityStore()
    for item in rows:
        key = str(item.get("activity_key") or "")
        indexed = store.get_activity(key) if key else None
        source = indexed or {
            **item,
            "fit_path": item.get("fit_path") or item.get("path"),
        }
        if source.get("activity_key"):
            handles.append(ActivityHandle.from_index_entry(source))
    status = str(result.get("status") or "")
    if handles:
        context.set_selected_activities(handles, scope={
            "type": scope_type,
            "workflow_id": result.get("workflow_id"),
        })
    elif status in {"completed", "partial", "no_activities"} or result.get("error") == "activity_index_failed":
        context.clear_activities()


def _install_synced_activity_selection(result: dict[str, Any], context: AgentContext) -> None:
    """Backward-compatible name for callers that install Garmin sync results."""
    _install_activity_selection(result, context, scope_type="garmin_sync_result")


def run_activity_workflow(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    from operations.activity.workflow_service import start_local_activity_workflow

    result = start_local_activity_workflow(
        limit=int(args.get("limit", 5)),
        order=str(args.get("order") or "latest"),
        sport_type=str(args["sport_type"]) if args.get("sport_type") else None,
        goals=args.get("goals") or ("ensure_summary",),
        force=bool(args.get("force")),
        force_upload=bool(args.get("force_upload")),
    )
    _install_activity_selection(result, context, scope_type="activity_workflow_result")
    return result


def rebuild_activity_reports(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    from operations.activity.report_batch import submit_activity_report_rebuild

    return submit_activity_report_rebuild(scope=str(args.get("scope") or "all"))


def get_activity_report_job(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    from operations.activity.report_batch import get_activity_report_job as get_job

    return get_job(str(args.get("job_id") or ""))


def get_activity_workflow(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    from operations.activity.workflow_service import get_activity_workflow as get_workflow

    return get_workflow(str(args.get("workflow_id") or ""))


def retry_activity_workflow(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    from operations.activity.workflow_service import retry_activity_workflow as retry_workflow

    task_ids = args.get("task_ids")
    return retry_workflow(
        str(args.get("workflow_id") or ""),
        task_ids=task_ids if isinstance(task_ids, list) else None,
    )


HANDLERS = {
    "sync_garmin_activities": sync_garmin_activities,
    "sync_and_run_activity_workflow": sync_and_run_activity_workflow,
    "run_activity_workflow": run_activity_workflow,
    "rebuild_activity_reports": rebuild_activity_reports,
    "get_activity_report_job": get_activity_report_job,
    "get_activity_workflow": get_activity_workflow,
    "retry_activity_workflow": retry_activity_workflow,
}
