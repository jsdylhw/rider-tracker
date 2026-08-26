"""开发/调试 CLI:检查工具返回、FIT 解析和 SQLite 活动目录.

主 CLI(app.cli) 面向日常使用;这里保留偏底层的验证入口.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import typer

from fit.paths import resolve_fit_path
from agent.tools import call_fit_analysis_tool, fit_data_tool_catalog
from services.activity.catalog import (
    get_activities_in_range,
    list_activities,
    rebuild_activity_index,
    resolve_activity,
    upsert_activity_from_fit,
)
from services.activity.fit_loader import parse_activity_fit as parse_fit
from storage.repositories.activity import ActivityStore

app = typer.Typer(help="Personal FIT Agent debug CLI")


@app.command("list-tools")
def list_tools_command() -> None:
    """列出 FIT hidden analysis loop 可用的只读工具."""
    tools = fit_data_tool_catalog()
    _echo_json({"count": len(tools), "tools": tools})


@app.command("tool-call")
def tool_call_command(
    name: str,
    fit_path: str | None = typer.Option(None, "--fit", help="需要当前 FIT 的数据工具可传 latest 或路径."),
    args: str = typer.Option("{}", "--args", help="JSON object 参数."),
    history: bool = True,
) -> None:
    """直接调用一个 FIT 分析只读工具,用于检查返回 payload."""
    arguments = _parse_args_json(args)
    parsed = None
    history_before = None
    if fit_path:
        fit = resolve_fit_path(fit_path)
        parsed = parse_fit(fit)
        if history:
            summary = parsed.get("summary") or {}
            before = summary.get("start_time_local") or summary.get("start_time")
            history_before = ActivityStore().query_history(before=before, days=90, limit=50)

    result = call_fit_analysis_tool(name, arguments, parsed=parsed, history_before=history_before)
    _echo_json(result)


@app.command("inspect-fit")
def inspect_fit_command(
    fit_path: str = typer.Argument("latest"),
    tool_name: str | None = typer.Argument(None),
    args: str = typer.Option("{}", "--args", help="可选:调用数据工具时传入的 JSON object 参数."),
    history: bool = typer.Option(True, "--history/--no-history", help="调用 get_history 等数据工具时是否带历史上下文."),
) -> None:
    """解析 FIT;如果传 tool_name,则直接调用对应只读数据工具."""
    fit = resolve_fit_path(fit_path)
    parsed = parse_fit(fit)
    if tool_name:
        history_before = None
        if history:
            summary_for_history = parsed.get("summary") or {}
            before = summary_for_history.get("start_time_local") or summary_for_history.get("start_time")
            history_before = ActivityStore().query_history(before=before, days=90, limit=50)
        result = call_fit_analysis_tool(
            tool_name,
            _parse_args_json(args),
            parsed=parsed,
            history_before=history_before,
        )
        _echo_json({
            "fit_path": str(fit),
            **result,
        })
        return

    summary = parsed.get("summary") or {}
    metadata = parsed.get("training_metadata") or {}
    _echo_json({
        "fit_path": str(fit),
        "summary": summary,
        "record_count": len(parsed.get("records") or []),
        "lap_count": len(parsed.get("laps") or []),
        "session_count": len(parsed.get("sessions") or []),
        "training_message_counts": metadata.get("message_counts"),
    })


@app.command("index-fit")
def index_fit_command(fit_path: str = typer.Argument("latest"), source: str = "manual") -> None:
    """把一个 FIT 文件登记到 SQLite 活动目录。"""
    fit = resolve_fit_path(fit_path)
    _echo_json(upsert_activity_from_fit(fit, source=source))


@app.command("rebuild-index")
def rebuild_index_command() -> None:
    """扫描本地 FIT，重建 SQLite 活动目录。"""
    _echo_json(rebuild_activity_index())


@app.command("storage-status")
def storage_status_command() -> None:
    """检查 SQLite 中的活动数和各报告版本数量。"""
    store = ActivityStore()
    _echo_json({
        "kind": "activity_storage_status",
        "activity_count": store.count_activities(),
        "report_counts": store.report_counts(),
    })


@app.command("rebuild-v2-reports")
def rebuild_v2_reports_command(
    scope: str = "all",
    activity_key: list[str] | None = typer.Option(None, "--activity-key", help="只重建指定 activity_key，可重复传入。"),
) -> None:
    """提交全量 V2 报告任务，并在 CLI 进程中等待最终结果。"""
    from operations.activity.report_batch import get_activity_report_job, submit_activity_report_rebuild

    submitted = submit_activity_report_rebuild(scope=scope, activity_keys=activity_key)
    typer.echo(f"report job {submitted.get('job_id')}: {submitted.get('status')}")
    job_id = str(submitted.get("job_id") or "")
    while job_id:
        current = get_activity_report_job(job_id)
        if current.get("status") not in {"queued", "running"}:
            _echo_json(current)
            return
        time.sleep(0.5)


@app.command("list-activities")
def list_activities_command(limit: int = 20, sport_type: str | None = None, order: str = "latest") -> None:
    _echo_json(list_activities(limit=limit, sport_type=sport_type, order=order))


@app.command("resolve-activity")
def resolve_activity_command(
    date_local: str | None = None,
    name: str | None = None,
    activity_key: str | None = None,
    activity_index: int | None = None,
    sport_type: str | None = None,
    match: str = "latest",
) -> None:
    _echo_json(resolve_activity(
        activity_key=activity_key,
        activity_index=activity_index,
        date_local=date_local,
        name=name,
        sport_type=sport_type,
        match=match,
    ))


@app.command("activities-in-range")
def activities_in_range_command(
    start_date: str,
    end_date: str,
    sport_type: str | None = None,
) -> None:
    _echo_json(get_activities_in_range(start_date=start_date, end_date=end_date, sport_type=sport_type))


def _parse_args_json(text: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"--args must be JSON object: {exc}") from exc
    if not isinstance(data, dict):
        raise typer.BadParameter("--args must be JSON object")
    return data


def _echo_json(data: Any) -> None:
    typer.echo(json.dumps(data, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    app()
