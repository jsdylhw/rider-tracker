"""通用 Workflow Run 调度器。

调度器只知道任务依赖、状态迁移和检查点；任务的业务含义由领域 handler 注册。
它不依赖 LLM 或 AgentContext。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from operations.runtime.models import (
    TERMINAL_TASK_STATUSES,
    recover_interrupted_tasks,
    transition_task,
    workflow_overview,
)


@dataclass(frozen=True)
class TaskExecution:
    """领域 handler 的结构化执行结果。"""

    status: str  # completed | skipped | failed
    details: dict[str, Any] = field(default_factory=dict)
    activity_update: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TaskHandler:
    """某一 task kind 的领域实现。"""

    execute: Callable[[dict[str, Any], dict[str, Any]], TaskExecution]


def execute_ready_tasks(
    run: dict[str, Any],
    *,
    handlers: dict[str, TaskHandler],
    checkpoint: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """推进已注册且可运行的任务，直至完成或无可运行任务。"""
    checkpoint = checkpoint or (lambda _run: None)

    if run.get("status") == "cancelled":
        checkpoint(run)
        return _result(run)

    if recover_interrupted_tasks(run):
        checkpoint(run)

    progress = True
    while progress:
        if run.get("status") == "cancelled":
            break
        progress = _skip_failed_dependents(run, checkpoint)
        if run.get("status") == "cancelled":
            break
        runnable = _runnable_tasks(run, handlers)
        if not runnable:
            break

        task = runnable[0]
        _execute_one(run, task, handlers[str(task["kind"])], checkpoint)
        progress = True

    checkpoint(run)
    return _result(run)


def _execute_one(
    run: dict[str, Any],
    task: dict[str, Any],
    handler: TaskHandler,
    checkpoint: Callable[[dict[str, Any]], None],
) -> None:
    task_id = str(task["task_id"])
    if run.get("status") == "cancelled":
        return
    transition_task(run, task_id, "running")
    checkpoint(run)
    if run.get("status") == "cancelled":
        transition_task(run, task_id, "skipped", reason="workflow_cancelled")
        checkpoint(run)
        return
    try:
        outcome = handler.execute(run, task)
    except Exception as exc:
        transition_task(run, task_id, "failed", error=type(exc).__name__, message=str(exc))
        checkpoint(run)
        return
    if outcome.status not in {"completed", "skipped", "failed"}:
        transition_task(run, task_id, "failed", error="invalid_handler_result", message=outcome.status)
        checkpoint(run)
        return
    _apply_activity_update(run, task, outcome.activity_update)
    transition_task(run, task_id, outcome.status, **outcome.details)
    checkpoint(run)


def _skip_failed_dependents(run: dict[str, Any], checkpoint: Callable[[dict[str, Any]], None]) -> bool:
    changed = False
    tasks = {str(task.get("task_id")): task for task in run.get("tasks") or [] if isinstance(task, dict)}
    for task in run.get("tasks") or []:
        if not isinstance(task, dict) or task.get("status") != "pending" or task.get("allow_failed_dependencies"):
            continue
        dependencies = [tasks.get(str(task_id)) for task_id in task.get("depends_on") or []]
        if any(dependency and dependency.get("status") == "failed" for dependency in dependencies):
            transition_task(run, str(task["task_id"]), "skipped", reason="dependency_failed")
            checkpoint(run)
            changed = True
    return changed


def _runnable_tasks(run: dict[str, Any], handlers: dict[str, TaskHandler]) -> list[dict[str, Any]]:
    tasks = {str(task.get("task_id")): task for task in run.get("tasks") or [] if isinstance(task, dict)}
    runnable: list[dict[str, Any]] = []
    for task in run.get("tasks") or []:
        if not isinstance(task, dict) or task.get("status") != "pending":
            continue
        if str(task.get("kind")) not in handlers:
            continue
        dependencies = [tasks.get(str(task_id)) for task_id in task.get("depends_on") or []]
        if any(dependency is None for dependency in dependencies):
            continue
        if all(str(dependency.get("status")) in TERMINAL_TASK_STATUSES for dependency in dependencies):
            runnable.append(task)
    return runnable


def _apply_activity_update(run: dict[str, Any], task: dict[str, Any], update: dict[str, Any]) -> None:
    if not update or not task.get("activity_key"):
        return
    activity_key = str(task["activity_key"])
    for activity in run.get("activities") or []:
        if isinstance(activity, dict) and str(activity.get("activity_key")) == activity_key:
            activity.update(update)
            return


def _result(run: dict[str, Any]) -> dict[str, Any]:
    return {
        "workflow": workflow_overview(run),
        "failed_tasks": [
            {"task_id": task.get("task_id"), "kind": task.get("kind"), "error": task.get("error")}
            for task in run.get("tasks") or []
            if isinstance(task, dict) and task.get("status") == "failed"
        ],
    }
