"""通用 Workflow Run 的纯数据模型和受限状态迁移。

本模块不导入 AgentContext、LLM 或任何原子工具。它只定义一次处理运行中的
活动快照、任务依赖及状态，供后续 factory / executor 使用。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable
from uuid import uuid4

WORKFLOW_SCHEMA_VERSION = "workflow_run.v1"
RUN_STATUSES = {"active", "paused", "completed", "partial", "cancelled"}
TASK_STATUSES = {"pending", "running", "completed", "skipped", "failed"}
TERMINAL_TASK_STATUSES = {"completed", "skipped", "failed"}

_ALLOWED_TRANSITIONS = {
    "pending": {"running", "skipped", "failed"},
    "running": {"completed", "skipped", "failed"},
    "failed": {"pending"},  # retry 必须显式发生
    "completed": set(),
    "skipped": set(),
}


class WorkflowStateError(ValueError):
    """任务或工作流状态不合法。"""


def create_workflow(
    *,
    request: dict[str, Any],
    activities: Iterable[dict[str, Any]],
    tasks: Iterable[dict[str, Any]],
    workflow_id: str | None = None,
) -> dict[str, Any]:
    """创建一个新的、可持久化的工作流运行快照。"""
    activity_rows = [_activity_ref(activity) for activity in activities]
    task_rows = [dict(task) for task in tasks]
    _validate_tasks(task_rows, activity_rows)
    now = _now()
    run = {
        "schema_version": WORKFLOW_SCHEMA_VERSION,
        "workflow_id": workflow_id or uuid4().hex,
        "created_at": now,
        "updated_at": now,
        "status": "active",
        "request": dict(request),
        "activities": activity_rows,
        "tasks": task_rows,
    }
    refresh_workflow_status(run)
    return run


def create_task(
    *,
    task_id: str,
    kind: str,
    activity_key: str | None = None,
    depends_on: Iterable[str] = (),
    allow_failed_dependencies: bool = False,
) -> dict[str, Any]:
    """创建尚未执行的任务节点。"""
    if not task_id or not kind:
        raise WorkflowStateError("task_id and kind are required")
    return {
        "task_id": task_id,
        "kind": kind,
        "activity_key": activity_key,
        "depends_on": list(dict.fromkeys(str(task) for task in depends_on)),
        "allow_failed_dependencies": bool(allow_failed_dependencies),
        "status": "pending",
        "attempts": 0,
    }


def task_by_id(run: dict[str, Any], task_id: str) -> dict[str, Any]:
    for task in run.get("tasks") or []:
        if isinstance(task, dict) and task.get("task_id") == task_id:
            return task
    raise WorkflowStateError(f"unknown task: {task_id}")


def transition_task(run: dict[str, Any], task_id: str, status: str, **details: Any) -> dict[str, Any]:
    """应用合法的状态迁移，并立刻刷新工作流状态。"""
    if status not in TASK_STATUSES:
        raise WorkflowStateError(f"invalid task status: {status}")
    task = task_by_id(run, task_id)
    current = str(task.get("status") or "pending")
    if status not in _ALLOWED_TRANSITIONS.get(current, set()):
        raise WorkflowStateError(f"invalid transition for {task_id}: {current} -> {status}")
    task["status"] = status
    if status == "running":
        task["attempts"] = int(task.get("attempts") or 0) + 1
    task.update({key: value for key, value in details.items() if value is not None})
    task["updated_at"] = _now()
    refresh_workflow_status(run)
    return task


def retry_task(run: dict[str, Any], task_id: str) -> dict[str, Any]:
    """只允许失败任务进入新的 pending 尝试，并保留上一次失败信息。"""
    if run.get("status") == "cancelled":
        raise WorkflowStateError("cannot retry a cancelled workflow")
    task = task_by_id(run, task_id)
    if task.get("status") != "failed":
        # 保持既有的状态机错误信息和校验语义。
        return transition_task(run, task_id, "pending")
    _reset_terminal_task(run, task, reason="explicit_retry")
    refresh_workflow_status(run)
    return task


def retry_failed_tasks(
    run: dict[str, Any],
    *,
    task_ids: Iterable[str] | None = None,
) -> list[str]:
    """显式重试失败任务，并恢复因其失败而跳过的下游任务。

    聚合类任务允许失败依赖并可能已经生成 partial 结果；只要它依赖被重试的
    任务，也必须重新计算，不能继续展示旧聚合快照。
    """
    if run.get("status") == "cancelled":
        raise WorkflowStateError("cannot retry a cancelled workflow")
    tasks = {str(task.get("task_id")): task for task in run.get("tasks") or [] if isinstance(task, dict)}
    requested = [str(task_id) for task_id in task_ids] if task_ids is not None else [
        task_id for task_id, task in tasks.items() if task.get("status") == "failed"
    ]
    if not requested:
        return []
    missing = [task_id for task_id in requested if task_id not in tasks]
    if missing:
        raise WorkflowStateError(f"unknown tasks for retry: {sorted(missing)}")
    not_failed = [task_id for task_id in requested if tasks[task_id].get("status") != "failed"]
    if not_failed:
        raise WorkflowStateError(f"only failed tasks can be retried: {sorted(not_failed)}")

    revived: list[str] = []
    changed = set(requested)
    for task_id in requested:
        retry_task(run, task_id)
        revived.append(task_id)

    progress = True
    while progress:
        progress = False
        for task_id, task in tasks.items():
            if task_id in changed or not changed.intersection(str(dep) for dep in task.get("depends_on") or []):
                continue
            status = str(task.get("status") or "")
            is_failed_dependency_skip = status == "skipped" and task.get("reason") == "dependency_failed"
            is_partial_aggregate = bool(task.get("allow_failed_dependencies")) and status in {"completed", "skipped"}
            if not (is_failed_dependency_skip or is_partial_aggregate):
                continue
            _reset_terminal_task(run, task, reason="upstream_retry")
            changed.add(task_id)
            revived.append(task_id)
            progress = True
    refresh_workflow_status(run)
    return revived


def cancel_workflow(run: dict[str, Any], *, reason: str = "cancelled_by_user") -> None:
    """取消整个运行；保留已完成任务及取消理由以便审计。"""
    if run.get("status") in {"completed", "cancelled"}:
        raise WorkflowStateError(f"cannot cancel workflow in state {run.get('status')}")
    run["status"] = "cancelled"
    run["cancellation"] = {"reason": reason, "created_at": _now()}
    run["updated_at"] = _now()


def recover_interrupted_tasks(run: dict[str, Any]) -> list[str]:
    """将上次进程退出时遗留的 running 任务变为可审计的失败状态。

    ``running`` 已经写入检查点，说明 handler 是否真正完成未知。特别是上传
    任务不能在没有用户确认的情况下假装 exactly-once 地自动重放；调用方可以
    通过现有 retry 接口显式开始下一次尝试。
    """
    if run.get("status") == "cancelled":
        return []
    recovered: list[str] = []
    for task in run.get("tasks") or []:
        if not isinstance(task, dict) or task.get("status") != "running":
            continue
        task_id = str(task.get("task_id") or "")
        transition_task(
            run,
            task_id,
            "failed",
            error="interrupted",
            message="Task was running when the previous process stopped; retry explicitly to continue.",
        )
        recovered.append(task_id)
    return recovered


def refresh_workflow_status(run: dict[str, Any]) -> str:
    if run.get("status") == "cancelled":
        return str(run["status"])
    statuses = [
        str(task.get("status") or "")
        for task in run.get("tasks") or []
        if isinstance(task, dict)
    ]
    if any(status in {"pending", "running"} for status in statuses):
        status = "active"
    elif any(status == "failed" for status in statuses):
        status = "partial"
    else:
        status = "completed"
    run["status"] = status
    run["updated_at"] = _now()
    return status


def workflow_overview(run: dict[str, Any]) -> dict[str, Any]:
    """给展示层使用的真实状态摘要。"""
    by_status: dict[str, int] = {}
    by_kind: dict[str, dict[str, int]] = {}
    for task in run.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        status = str(task.get("status") or "unknown")
        kind = str(task.get("kind") or "unknown")
        by_status[status] = by_status.get(status, 0) + 1
        kind_status = by_kind.setdefault(kind, {})
        kind_status[status] = kind_status.get(status, 0) + 1
    return {
        "workflow_id": run.get("workflow_id"),
        "status": refresh_workflow_status(run),
        "activity_count": len(run.get("activities") or []),
        "tasks_by_status": by_status,
        "tasks_by_kind": by_kind,
        "pause": run.get("pause") if run.get("status") == "paused" else None,
    }


def _activity_ref(activity: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(activity, dict) or not activity.get("activity_key"):
        raise WorkflowStateError("every workflow activity needs activity_key")
    return {
        key: activity.get(key)
        for key in (
            "activity_key", "fit_path", "strava_activity_id",
            "file_name", "sport_type", "start_time_local", "date_local", "source_activity_id",
        )
        if activity.get(key) is not None
    }


def _validate_tasks(tasks: list[dict[str, Any]], activities: list[dict[str, Any]]) -> None:
    task_ids = [str(task.get("task_id") or "") for task in tasks]
    if any(not task_id for task_id in task_ids) or len(task_ids) != len(set(task_ids)):
        raise WorkflowStateError("workflow task_id values must be unique and non-empty")
    activity_keys = {str(activity["activity_key"]) for activity in activities}
    for task in tasks:
        status = str(task.get("status") or "pending")
        if status not in TASK_STATUSES:
            raise WorkflowStateError(f"invalid initial task status: {status}")
        key = task.get("activity_key")
        if key is not None and str(key) not in activity_keys:
            raise WorkflowStateError(f"task references unknown activity: {key}")
        dependencies = [str(value) for value in task.get("depends_on") or []]
        missing = set(dependencies) - set(task_ids)
        if missing:
            raise WorkflowStateError(f"task {task.get('task_id')} references missing dependencies: {sorted(missing)}")


def _reset_terminal_task(run: dict[str, Any], task: dict[str, Any], *, reason: str) -> None:
    """为明确的上游重试重置派生任务，保留旧结果在 attempt_history 中。"""
    if task.get("status") not in TERMINAL_TASK_STATUSES:
        raise WorkflowStateError(f"cannot reset non-terminal task: {task.get('task_id')}")
    snapshot = {
        key: value
        for key, value in task.items()
        if key not in {"status", "updated_at", "attempt_history"}
        and key not in {"task_id", "kind", "activity_key", "depends_on", "allow_failed_dependencies"}
    }
    task.setdefault("attempt_history", []).append({
        "status": task.get("status"),
        "finished_at": task.get("updated_at"),
        "details": snapshot,
    })
    for key in ("error", "message", "reason", "outcome", "report", "result_status", "strava_activity_id"):
        task.pop(key, None)
    task["status"] = "pending"
    task["retry_reason"] = reason
    task["updated_at"] = _now()


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")
