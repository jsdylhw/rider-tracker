"""CLI 入口:覆盖对话、分析、同步、上传和 Strava 认证等操作.

通过 typer 注册,入口点为 python -m app.cli <command>.
"""

import json

import typer

from agent.runtime.chat_logger import new_session_id
from agent.main_agent.context import AgentContext
from agent.main_agent.loop import run_tool_loop
from fit.paths import resolve_fit_path
from operations.activity.service import MAX_SYNC_COUNT, analyze_fit_file_tool, sync_garmin_activities_tool
from operations.activity.facts import rebuild_activity_facts
from operations.activity.strava import (
    update_strava_description,
    upload_activity_to_strava,
)
from integrations.strava import StravaSink


app = typer.Typer(help="Personal FIT Agent CLI")


@app.command("chat")
def chat_command(
    message: str | None = typer.Argument(None, help="单次对话内容。不传则进入交互模式。"),
    fit_path: str | None = typer.Option(None, "--fit", help="可选:当前 FIT 文件路径或 latest."),
    max_tokens: int = typer.Option(4096, "--max-tokens", help="LLM 最大输出 token 数."),
    workspace: str = typer.Option("default", "--workspace", help="跨进程恢复活动分析焦点的工作区名称。"),
) -> None:
    """对话模式 — Main Agent 原生 tool use。不传 message 进入交互模式，q/quit 退出。"""
    if message:
        context = AgentContext(
            session_id=new_session_id("tool_loop"),
            workspace_id=workspace,
            current_fit_file=resolve_fit_path(fit_path) if fit_path else None,
        )
        from agent.analysis.workspace import AnalysisNavigationService

        AnalysisNavigationService().load_into_context(context)
        result = run_tool_loop(message, max_tokens=max_tokens, verbose=True, context=context)
        typer.echo("")
        typer.echo(result["answer"])
        return

    # 交互模式
    typer.echo("Personal FIT Agent (chat mode) — 输入 q/quit 退出")
    context = AgentContext(
        session_id=new_session_id("tool_loop"),
        workspace_id=workspace,
        current_fit_file=resolve_fit_path(fit_path) if fit_path else None,
    )
    from agent.analysis.workspace import AnalysisNavigationService

    AnalysisNavigationService().load_into_context(context)
    while True:
        try:
            user_input = typer.prompt(">").strip()
        except (EOFError, KeyboardInterrupt):
            typer.echo("")
            break

        if not user_input:
            continue
        if user_input.lower() in ("q", "quit", "exit"):
            break

        result = run_tool_loop(user_input, max_tokens=max_tokens, verbose=True, context=context)
        context = result.get("context")
        typer.echo("")
        typer.echo(result["answer"])
        typer.echo("")
        typer.echo(f"\033[2mstatus: {result['status']} | intent: {result.get('intent', '?')}\033[0m")
        typer.echo("")


@app.command("analyze-file")
def analyze_file_command(
    path: str = typer.Argument("latest"),
    force: bool = False,
) -> None:
    fit = resolve_fit_path(path)
    result = analyze_fit_file_tool(str(fit), force=force)
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2, default=str))


@app.command("sync-garmin")
def sync_garmin_command(
    count: int = typer.Option(
        5,
        "--count",
        "-n",
        min=1,
        max=MAX_SYNC_COUNT,
        help=f"下载最近 N 条 Garmin 活动,最多 {MAX_SYNC_COUNT} 条.",
    ),
    force_download: bool = typer.Option(
        False,
        "--force-download",
        help="重新下载本地已有的同一 Garmin 活动原始 FIT。",
    ),
) -> None:
    """下载 Garmin 中国区最近活动 FIT 文件,自动跳过本地已有文件."""
    try:
        result = sync_garmin_activities_tool(count=count, force_download=force_download)
    except Exception as exc:
        # Typer/Rich 的默认 traceback 会展开局部变量，可能把配置凭据一并打印。
        typer.echo(f"Garmin 同步失败：{exc}", err=True)
        raise typer.Exit(code=1) from None
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2, default=str))


@app.command("rebuild-facts")
def rebuild_facts_command(
    force: bool = typer.Option(False, "--force", help="重新计算已有活动的确定性指标和特征"),
) -> None:
    """补齐导入前遗留活动的 metrics/features，不调用 LLM、不生成报告。"""
    result = rebuild_activity_facts(force=force)
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2, default=str))


@app.command("upload-strava")
def upload_strava_command(
    activity_key: str,
    title: str | None = None,
    wait: bool = True,
    force: bool = typer.Option(False, "--force", help="遇到重复活动时不报错,改为更新已有活动的描述"),
) -> None:
    result = upload_activity_to_strava(activity_key, title=title, wait=wait, force=force)
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2, default=str))


@app.command("update-strava-description")
def update_strava_description_command(activity_id: str, activity_key: str) -> None:
    result = update_strava_description(activity_id, activity_key)
    typer.echo(f"已更新 Strava 活动 {activity_id} 的描述。")
    detail = result.get("description")
    if detail:
        typer.echo(f"描述长度: {len(detail)} 字符")


@app.command("strava-auth-url")
def strava_auth_url_command(
    redirect_uri: str = "http://localhost",
    scope: str = "read,activity:read_all,activity:write",
) -> None:
    sink = StravaSink(require_access_token=False)
    typer.echo(sink.build_authorize_url(redirect_uri=redirect_uri, scope=scope))


@app.command("strava-exchange-code")
def strava_exchange_code_command(code: str) -> None:
    result = StravaSink(require_access_token=False).exchange_authorization_code(code)
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2, default=str))


@app.command("strava-check-auth")
def strava_check_auth_command() -> None:
    athlete = StravaSink().get_athlete()
    safe = {
        key: athlete.get(key)
        for key in ["id", "username", "firstname", "lastname", "city", "country"]
        if key in athlete
    }
    typer.echo(json.dumps(safe, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    app()
