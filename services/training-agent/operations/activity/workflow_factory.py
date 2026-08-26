"""从活动目录创建持久化 ActivityRun 任务图。

Factory 只负责目标快照和依赖建图；不调用 LLM、不分析 FIT，也不上传 Strava。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from operations.activity.catalog import resolve_recent
from operations.runtime.models import create_task, create_workflow, workflow_overview
from storage.repositories.workflow import save_workflow

DEFAULT_ACTIVITY_RUN_DIRECTORY = Path("data") / "activity_runs"

TASK_ENSURE_SUMMARY = "ensure_summary"
TASK_UPLOAD_STRAVA = "upload_strava"
TASK_AGGREGATE_REPORT = "aggregate_report"
SUPPORTED_GOALS = {TASK_ENSURE_SUMMARY, TASK_UPLOAD_STRAVA, TASK_AGGREGATE_REPORT}


def create_local_activity_run(
    *,
    limit: int = 5,
    order: str = "latest",
    sport_type: str | None = None,
    goals: Iterable[str] = (TASK_ENSURE_SUMMARY,),
    force: bool = False,
    force_upload: bool = False,
    directory: str | Path | None = None,
) -> dict[str, Any]:
    """从本地索引创建 ActivityRun，不触发 Garmin 同步。"""
    requested_goals = list(goals)
    resolution = resolve_recent(limit=limit, order=order, sport_type=sport_type)
    if resolution.get("status") != "completed":
        return {
            "operation": "create_activity_run",
            "status": "failed",
            "error": resolution.get("error") or "activity_selection_failed",
            "message": resolution.get("message") or "无法定位本地活动",
        }
    activities = resolution.get("activities") or []
    if not activities:
        return {
            "operation": "create_activity_run",
            "status": "no_activities",
            "selection": resolution.get("selection"),
            "message": "没有符合条件的本地活动；未创建工作流。",
        }

    return create_activity_run_from_activities(
        activities,
        request={
            "source": "local",
            "selection": resolution.get("selection"),
            "goals": requested_goals,
            "force": bool(force),
            "force_upload": bool(force_upload),
        },
        directory=directory,
    )


def create_activity_run_from_activities(
    activities: Iterable[dict[str, Any]],
    *,
    request: dict[str, Any],
    directory: str | Path | None = None,
) -> dict[str, Any]:
    """根据显式活动快照创建并保存 ActivityRun。"""
    goals = _normalize_goals(request.get("goals") or ())
    rows = [dict(activity) for activity in activities if isinstance(activity, dict) and activity.get("activity_key")]
    if not rows:
        return {
            "operation": "create_activity_run",
            "status": "no_activities",
            "message": "没有带 activity_key 的活动；未创建工作流。",
        }

    tasks: list[dict[str, Any]] = []
    summary_ids: list[str] = []
    for activity in rows:
        key = str(activity["activity_key"])
        summary_id = _task_id(key, TASK_ENSURE_SUMMARY)
        tasks.append(create_task(task_id=summary_id, kind=TASK_ENSURE_SUMMARY, activity_key=key))
        summary_ids.append(summary_id)
        if TASK_UPLOAD_STRAVA in goals:
            tasks.append(create_task(
                task_id=_task_id(key, TASK_UPLOAD_STRAVA),
                kind=TASK_UPLOAD_STRAVA,
                activity_key=key,
                depends_on=(summary_id,),
            ))
    if TASK_AGGREGATE_REPORT in goals:
        tasks.append(create_task(
            task_id=TASK_AGGREGATE_REPORT,
            kind=TASK_AGGREGATE_REPORT,
            depends_on=summary_ids,
            allow_failed_dependencies=True,
        ))

    run = create_workflow(
        request={**request, "goals": goals},
        activities=rows,
        tasks=tasks,
    )
    target_directory = Path(directory) if directory is not None else DEFAULT_ACTIVITY_RUN_DIRECTORY
    # workflow_overview refreshes status/updated_at, so compute it before the
    # snapshot is persisted to keep the returned object equal to disk state.
    overview = workflow_overview(run)
    path = save_workflow(run, directory=target_directory)
    return {
        "operation": "create_activity_run",
        "status": "created",
        "run": run,
        "run_path": str(path),
        "overview": overview,
    }


def _normalize_goals(goals: Iterable[str]) -> list[str]:
    normalized = list(dict.fromkeys(str(goal) for goal in goals))
    invalid = set(normalized) - SUPPORTED_GOALS
    if invalid:
        raise ValueError(f"unsupported activity run goals: {sorted(invalid)}")
    # 上传与聚合都以单条 summary 为稳定中间产物，不能缺少该依赖。
    if TASK_UPLOAD_STRAVA in normalized or TASK_AGGREGATE_REPORT in normalized:
        normalized.insert(0, TASK_ENSURE_SUMMARY)
        normalized = list(dict.fromkeys(normalized))
    if not normalized:
        normalized = [TASK_ENSURE_SUMMARY]
    return normalized


def _task_id(activity_key: str, kind: str) -> str:
    return f"{activity_key}:{kind}"
