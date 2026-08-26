"""ActivityRun 的高层服务入口。

这里是未来聊天工具、CLI 或 API 的共同边界：调用方只表达“创建、查看、重试”，
不需要枚举每个活动并手工串接分析或上传工具。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from operations.activity.workflow_executor import execute_activity_run
from operations.activity.workflow_factory import (
    DEFAULT_ACTIVITY_RUN_DIRECTORY,
    create_activity_run_from_activities,
    create_local_activity_run,
)
from operations.activity.sync import sync_recent
from operations.runtime.models import (
    WorkflowStateError,
    recover_interrupted_tasks,
    retry_failed_tasks,
    workflow_overview,
)
from storage.repositories.workflow import (
    WorkflowLockError,
    acquire_workflow_lock,
    load_workflow,
    save_workflow,
    workflow_path,
)
from storage.repositories.activity import ActivityStore


def start_local_activity_workflow(
    *,
    limit: int = 5,
    order: str = "latest",
    sport_type: str | None = None,
    goals: Iterable[str] = ("ensure_summary",),
    force: bool = False,
    force_upload: bool = False,
    directory: str | Path | None = None,
) -> dict[str, Any]:
    """为已在本地的活动创建并立即推进一个新的运行。"""
    target_directory = _directory(directory)
    created = create_local_activity_run(
        limit=limit,
        order=order,
        sport_type=sport_type,
        goals=goals,
        force=force,
        force_upload=force_upload,
        directory=target_directory,
    )
    if created.get("status") != "created":
        return created
    run = created["run"]
    execution = execute_activity_run(run, directory=target_directory)
    return _response(run, target_directory, execution=execution, created=True)


def sync_and_start_activity_workflow(
    *,
    count: int = 5,
    goals: Iterable[str] = ("ensure_summary",),
    force: bool = False,
    force_download: bool = False,
    force_upload: bool = False,
    directory: str | Path | None = None,
) -> dict[str, Any]:
    """同步 Garmin 后，仅用本次成功索引的活动创建并推进 Run。

    同步不是 per-activity 任务：它发生在可冻结活动快照之前。其结果被写入
    Run.request.sync，之后 summary/upload/aggregate 仍使用同一 ActivityRun 状态机。
    """
    target_directory = _directory(directory)
    sync = sync_recent(count=count, force_download=force_download)
    if sync.get("status") == "failed":
        return {
            "operation": "sync_and_start_activity_workflow",
            "status": "failed",
            "error": sync.get("error") or "garmin_sync_failed",
            "message": sync.get("message") or "Garmin 同步失败",
            "sync": _sync_overview(sync, requested_count=count),
        }

    activities = _synced_activities(sync.get("activities") or [])
    if not activities:
        index_failed = int(sync.get("index_failed") or 0)
        response = {
            "operation": "sync_and_start_activity_workflow",
            "status": "failed" if index_failed else "no_activities",
            "message": (
                f"Garmin FIT 已获取，但有 {index_failed} 个文件索引失败；未创建工作流。"
                if index_failed else
                "Garmin 同步没有产生可索引的 FIT 活动；未创建工作流。"
            ),
            "sync": _sync_overview(sync, requested_count=count),
        }
        if index_failed:
            response["error"] = "activity_index_failed"
        return response

    created = create_activity_run_from_activities(
        activities,
        request={
            "source": "garmin_sync",
            "selection": {
                "kind": "garmin_sync_result",
                "requested_count": count,
                "activity_keys": [activity["activity_key"] for activity in activities],
            },
            "sync": _sync_overview(sync, requested_count=count),
            "goals": list(goals),
            "force": bool(force),
            "force_download": bool(force_download),
            "force_upload": bool(force_upload),
        },
        directory=target_directory,
    )
    if created.get("status") != "created":
        return {**created, "sync": _sync_overview(sync, requested_count=count)}
    run = created["run"]
    execution = execute_activity_run(run, directory=target_directory)
    response = {
        **_response(run, target_directory, execution=execution, created=True),
        "sync": _sync_overview(sync, requested_count=count),
    }
    if sync.get("status") == "partial" and response.get("status") == "completed":
        response["status"] = "partial"
        response["answer"] = _append_sync_warning(response.get("answer"), response.get("sync") or {})
    return response


def get_activity_workflow(
    workflow_id: str,
    *,
    directory: str | Path | None = None,
) -> dict[str, Any]:
    """读取一个持久化运行，不推进也不触发任何副作用。"""
    target_directory = _directory(directory)
    run = load_workflow(workflow_id, directory=target_directory)
    if run is None:
        return _not_found(workflow_id)
    return _response(run, target_directory)


def retry_activity_workflow(
    workflow_id: str,
    *,
    task_ids: Iterable[str] | None = None,
    directory: str | Path | None = None,
) -> dict[str, Any]:
    """重试失败任务并恢复其依赖失败而跳过的后续任务。"""
    target_directory = _directory(directory)
    run = load_workflow(workflow_id, directory=target_directory)
    if run is None:
        return _not_found(workflow_id)
    try:
        with acquire_workflow_lock(workflow_id, directory=target_directory):
            # The prior lock holder may have checkpointed after our first read.
            run = load_workflow(workflow_id, directory=target_directory)
            if run is None:
                return _not_found(workflow_id)
            # A lock guarantees no active executor owns this Run.  Only now
            # may a persisted running task be classified as crash-interrupted.
            if recover_interrupted_tasks(run):
                save_workflow(run, directory=target_directory)
            try:
                revived_task_ids = retry_failed_tasks(run, task_ids=task_ids)
            except WorkflowStateError as exc:
                return {
                    "operation": "retry_activity_workflow",
                    "status": "failed",
                    "error": "retry_not_available",
                    "message": str(exc),
                    "workflow": workflow_overview(run),
                }
            if not revived_task_ids:
                return {
                    **_response(run, target_directory),
                    "status": "nothing_to_retry",
                    "message": "当前运行没有失败任务。",
                }
            save_workflow(run, directory=target_directory)
            execution = execute_activity_run(run, directory=target_directory, lock_held=True)
            return {
                **_response(run, target_directory, execution=execution),
                "retried_task_ids": revived_task_ids,
            }
    except WorkflowLockError as exc:
        return {
            **_response(run, target_directory),
            "status": "busy",
            "error": "workflow_locked",
            "message": str(exc),
        }


def _response(
    run: dict[str, Any],
    directory: Path,
    *,
    execution: dict[str, Any] | None = None,
    created: bool = False,
) -> dict[str, Any]:
    overview = workflow_overview(run)
    response = {
        "operation": "activity_workflow",
        "status": overview["status"],
        "created": created,
        "workflow_id": run.get("workflow_id"),
        "run_path": str(workflow_path(str(run.get("workflow_id")), directory=directory)),
        "workflow": overview,
        "activities": run.get("activities") or [],
        "tasks": run.get("tasks") or [],
        "answer": _workflow_answer(run),
    }
    if execution is not None:
        response["execution"] = execution
    return response


def _not_found(workflow_id: str) -> dict[str, Any]:
    return {
        "operation": "activity_workflow",
        "status": "not_found",
        "error": "workflow_not_found",
        "message": f"找不到活动工作流: {workflow_id}",
    }


def _workflow_answer(run: dict[str, Any]) -> str:
    """Describe persisted task outcomes without relying on another model call."""
    overview = workflow_overview(run)
    status = str(overview.get("status") or "unknown")
    activities = [item for item in run.get("activities") or [] if isinstance(item, dict)]
    labels = [_activity_label(item) for item in activities[:2]]
    target = "；".join(label for label in labels if label) or "所选活动"
    if len(activities) > len(labels):
        target += f" 等 {len(activities)} 条活动"

    if status == "completed":
        heading = f"处理完成：{target}。"
    elif status == "partial":
        heading = f"处理部分完成：{target}。"
    elif status == "cancelled":
        heading = f"处理已取消：{target}。"
    else:
        heading = f"处理状态为 {status}：{target}。"

    activity_labels = {
        str(activity.get("activity_key") or ""): _activity_label(activity)
        for activity in activities
    }
    details = [
        _task_outcome(
            task,
            activity_label=activity_labels.get(str(task.get("activity_key") or "")),
        )
        for task in run.get("tasks") or [] if isinstance(task, dict)
    ]
    return "\n".join([heading, *(f"- {detail}" for detail in details if detail)])


def _activity_label(activity: dict[str, Any]) -> str:
    started = activity.get("start_time_local") or activity.get("date_local")
    name = activity.get("summary_label") or activity.get("file_name")
    return " ".join(str(value) for value in (started, name) if value) or str(activity.get("activity_key") or "")


def _task_outcome(task: dict[str, Any], *, activity_label: str | None = None) -> str:
    kind = str(task.get("kind") or "task")
    status = str(task.get("status") or "pending")
    if kind == "ensure_summary":
        label = "活动分析"
        success = "报告已生成"
    elif kind == "upload_strava":
        label = "Strava 上传"
        success = "已完成"
    elif kind == "aggregate_report":
        label = "汇总报告"
        success = "已生成"
    else:
        label = kind
        success = "已完成"

    if status == "completed":
        suffix = ""
        if kind == "upload_strava" and task.get("strava_activity_id"):
            suffix = f"（activity_id={task['strava_activity_id']}）"
        if kind == "upload_strava" and task.get("outcome") == "duplicate":
            outcome = f"{label}活动已存在，未重复上传{suffix}。"
        else:
            outcome = f"{label}{success}{suffix}。"
        return f"{activity_label}：{outcome}" if activity_label else outcome
    if status == "failed":
        message = task.get("message") or task.get("error") or "未知错误"
        outcome = f"{label}失败：{message}。"
        return f"{activity_label}：{outcome}" if activity_label else outcome
    if status == "skipped":
        reason = str(task.get("reason") or "")
        if reason == "existing_report":
            outcome = f"{label}复用已有报告。"
        elif reason == "already_uploaded":
            activity_id = task.get("strava_activity_id")
            suffix = f"（activity_id={activity_id}）" if activity_id else ""
            outcome = f"{label}已存在，未重复上传{suffix}。"
        elif reason == "dependency_failed":
            outcome = f"{label}未执行：前置任务失败。"
        else:
            outcome = f"{label}已跳过{f'：{reason}' if reason else ''}。"
        return f"{activity_label}：{outcome}" if activity_label else outcome
    outcome = f"{label}尚未完成（{status}）。"
    return f"{activity_label}：{outcome}" if activity_label else outcome


def _append_sync_warning(answer: Any, sync: dict[str, Any]) -> str:
    failed = int(sync.get("failed") or 0)
    index_failed = int(sync.get("index_failed") or 0)
    warning = f"Garmin 同步部分完成：下载失败 {failed} 条，索引失败 {index_failed} 条。"
    return f"{str(answer or '').rstrip()}\n- {warning}".strip()


def _directory(directory: str | Path | None) -> Path:
    return Path(directory) if directory is not None else DEFAULT_ACTIVITY_RUN_DIRECTORY


def _synced_activities(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """冻结同步选中的精确集合，并从 SQLite 补齐当前权威状态。"""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    store = ActivityStore()
    for item in items:
        if not isinstance(item, dict) or not item.get("activity_key") or not item.get("path"):
            continue
        key = str(item["activity_key"])
        if key in seen:
            continue
        seen.add(key)
        synced = {
            "activity_key": key,
            "fit_path": str(item["path"]),
            "source_activity_id": str(item["activity_id"]) if item.get("activity_id") is not None else None,
            "sport_type": item.get("sport_type"),
            "start_time_local": item.get("start_time_local"),
        }
        stored = store.get_activity(key) or {}
        rows.append({**synced, **stored, "activity_key": key})
    return rows


def _sync_overview(sync: dict[str, Any], *, requested_count: int) -> dict[str, Any]:
    return {
        "requested_count": requested_count,
        "status": sync.get("status"),
        "downloaded": int(sync.get("downloaded") or 0),
        "skipped": int(sync.get("skipped") or 0),
        "failed": int(sync.get("failed") or 0),
        "index_failed": int(sync.get("index_failed") or 0),
        "indexed_activity_keys": [
            str(item["activity_key"])
            for item in sync.get("activities") or []
            if isinstance(item, dict) and item.get("activity_key")
        ],
        "failed_items": sync.get("failed_items") or [],
        "index_errors": sync.get("index_errors") or [],
        "force_download": bool(sync.get("force_download")),
    }
