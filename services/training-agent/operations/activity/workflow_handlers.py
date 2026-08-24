"""ActivityRun 任务类型到无会话状态领域操作的映射。"""

from __future__ import annotations

from typing import Any

from operations.activity.reporting import ensure_summary
from operations.activity.aggregate import aggregate_summaries
from operations.activity.upload import upload_activity
from operations.activity.workflow_factory import (
    TASK_AGGREGATE_REPORT,
    TASK_ENSURE_SUMMARY,
    TASK_UPLOAD_STRAVA,
)
from operations.runtime.executor import TaskExecution, TaskHandler
from storage.repositories.activity import ActivityStore

def activity_task_handlers() -> dict[str, TaskHandler]:
    """注册活动领域任务。任务直接执行，状态由持久化 Run 记录。"""
    return {
        TASK_ENSURE_SUMMARY: TaskHandler(execute=_ensure_summary),
        TASK_AGGREGATE_REPORT: TaskHandler(execute=_aggregate_report),
        TASK_UPLOAD_STRAVA: TaskHandler(execute=_upload_strava),
    }


def _ensure_summary(run: dict[str, Any], task: dict[str, Any]) -> TaskExecution:
    activity = _activity(run, task)
    if activity is None:
        return TaskExecution(status="failed", details={"error": "missing_activity"})
    if _has_existing_report(activity) and not bool((run.get("request") or {}).get("force")):
        return TaskExecution(
            status="skipped",
            details={"reason": "existing_report"},
        )
    fit_path = activity.get("fit_path")
    if not fit_path:
        return TaskExecution(status="failed", details={"error": "missing_fit_path"})
    result = ensure_summary(str(fit_path), force=bool((run.get("request") or {}).get("force")))
    status = str(result.get("status") or "failed")
    if status == "failed":
        return TaskExecution(
            status="failed",
            details={"error": result.get("error"), "message": result.get("message")},
        )
    return TaskExecution(
        status="skipped" if status == "skipped" else "completed",
        details={
            "report_schema_version": result.get("report_schema_version"),
            "result_status": result.get("result_status"),
        },
    )


def _aggregate_report(run: dict[str, Any], task: dict[str, Any]) -> TaskExecution:
    report = aggregate_summaries(run.get("activities") or [])
    return TaskExecution(
        status="completed",
        details={"report": report, "result_status": report.get("status")},
    )


def _upload_strava(run: dict[str, Any], task: dict[str, Any]) -> TaskExecution:
    activity = _activity(run, task)
    if activity is None:
        return TaskExecution(status="failed", details={"error": "missing_activity"})
    request = run.get("request") or {}
    if activity.get("strava_activity_id") and not bool(request.get("force_upload")):
        return TaskExecution(
            status="skipped",
            details={
                "reason": "already_uploaded",
                "strava_activity_id": activity.get("strava_activity_id"),
            },
        )
    fit_path = activity.get("fit_path")
    if not fit_path:
        return TaskExecution(status="failed", details={"error": "missing_fit_path"})

    result = upload_activity(str(fit_path), force=bool(request.get("force_upload")))
    if result.get("status") != "completed":
        return TaskExecution(
            status="failed",
            details={"error": result.get("error"), "message": result.get("message")},
        )
    strava_activity_id = result.get("strava_activity_id")
    activity_update = {"strava_activity_id": strava_activity_id} if strava_activity_id is not None else {}
    return TaskExecution(
        status="completed",
        details={
            "outcome": result.get("outcome"),
            "strava_activity_id": strava_activity_id,
        },
        activity_update=activity_update,
    )


def _activity(run: dict[str, Any], task: dict[str, Any]) -> dict[str, Any] | None:
    key = str(task.get("activity_key") or "")
    for activity in run.get("activities") or []:
        if isinstance(activity, dict) and str(activity.get("activity_key")) == key:
            return activity
    return None


def _has_existing_report(activity: dict[str, Any]) -> bool:
    """Return report existence from SQLite; exported JSON is irrelevant."""
    activity_key = str(activity.get("activity_key") or "")
    return bool(activity_key and ActivityStore().get_report_for_activity(activity))
