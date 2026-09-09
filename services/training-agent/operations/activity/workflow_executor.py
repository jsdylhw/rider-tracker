"""ActivityRun 的最小执行入口：保存检查点并调用通用 Runtime。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from operations.activity.workflow_handlers import activity_task_handlers
from operations.runtime.executor import execute_ready_tasks
from operations.runtime.models import workflow_overview
from storage.repositories.workflow import WorkflowLockError, acquire_workflow_lock, save_workflow


def execute_activity_run(
    run: dict[str, Any],
    *,
    directory: str | Path,
    lock_held: bool = False,
) -> dict[str, Any]:
    """执行已注册的活动任务，每次状态变更都原子保存同一 Run。"""
    if lock_held:
        return _execute(run, directory=directory)
    try:
        with acquire_workflow_lock(str(run.get("workflow_id") or ""), directory=directory):
            return _execute(run, directory=directory)
    except WorkflowLockError as exc:
        return {
            "workflow": workflow_overview(run),
            "failed_tasks": [],
            "busy": True,
            "error": "workflow_locked",
            "message": str(exc),
        }


def _execute(run: dict[str, Any], *, directory: str | Path) -> dict[str, Any]:
    return execute_ready_tasks(
        run,
        handlers=activity_task_handlers(),
        checkpoint=lambda current: save_workflow(current, directory=directory),
    )
