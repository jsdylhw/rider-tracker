"""Agent-facing report handlers backed by SQLite and the activity child agent."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from agent.analysis.agent import run_activity_analysis_agent
from agent.analysis.query import run_activity_query_agent
from agent.main_agent.context import AgentContext
from domain.analysis.artifacts import build_history_view, get_analysis_summary
from services.activity.reporting import read_activity_report


def analyze_activity(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    """Validate the frozen selection before reading or generating one report."""
    from agent.tools.handlers.activity_summary import empty_activity_selection_answer

    last = context.last_tool_result or {}
    last_result = last.get("result") if isinstance(last.get("result"), dict) else {}
    empty_answer = empty_activity_selection_answer(
        str(last_result.get("selection_mode") or ""), last_result,
    )
    if empty_answer:
        return {
            "step": "analyze_activity",
            "status": "completed",
            "answer": empty_answer,
            "result": {
                "schema_version": "activity_analysis_skipped.v1",
                "reason": "empty_activity_selection",
            },
        }
    if len(context.selected_activities) != 1:
        return {
            "error": "single_activity_required",
            "message": "analyze_activity 只能读取一条已定位活动；多条活动请使用 summarize_activities。",
            "selected_count": len(context.selected_activities),
        }
    return show_selected_activity_report_tool(context, args=args, name="analyze_activity")


def query_activity_detail(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    if len(context.selected_activities) != 1:
        return {
            "error": "single_activity_required",
            "message": "query_activity_detail 只能查询一条已定位活动；请先用 resolve_activities 精确定位。",
            "selected_count": len(context.selected_activities),
        }
    return query_selected_activity_detail_tool(
        context,
        question=str(args.get("question") or "").strip(),
        name="query_activity_detail",
    )


def show_selected_activity_report_tool(
    context: AgentContext,
    *,
    args: dict[str, Any] | None = None,
    name: str = "analyze_activity",
) -> dict[str, Any]:
    """展示单活动报告;无 summary 但有 FIT 时触发文件分析工具链路."""
    args = args or {}
    activity = _selected_activity(context)
    if not activity:
        return {
            "error": "missing_selected_activity",
            "message": "analyze_activity requires a resolved activity.",
        }

    summary, error = read_activity_report(activity)
    if bool(args.get("force")) and isinstance(summary, dict):
        refreshed_activity = {
            **activity,
            "fit_path": activity.get("fit_path") or summary.get("fit_path"),
            "activity_key": activity.get("activity_key") or summary.get("activity_key"),
        }
        generated = _analyze_missing_summary(name, args, context, refreshed_activity)
        if generated.get("error"):
            return generated
        return generated

    if error or summary is None:
        generated = _analyze_missing_summary(name, args, context, activity)
        if generated.get("error"):
            return generated
        return generated

    report = str(summary.get("markdown_report") or "").strip()
    if not report:
        report = _fallback_report(summary)

    if not report:
        return {
            "error": "missing_markdown_report",
            "message": "Summary exists but does not contain markdown_report or analysis_summary.",
        }

    return {
        "step": name,
        "status": "completed",
        "answer": report,
        "result": {
            "schema_version": "activity_report.v1",
            "activity_key": summary.get("activity_key") or activity.get("activity_key"),
            "fit_path": summary.get("fit_path") or activity.get("fit_path"),
            "source": "existing_report",
            "fit_summary": summary.get("fit_summary") if isinstance(summary.get("fit_summary"), dict) else {},
            "analysis_summary": get_analysis_summary(summary),
        },
    }


def query_selected_activity_detail_tool(
    context: AgentContext,
    *,
    question: str,
    name: str = "query_activity_detail",
) -> dict[str, Any]:
    """Answer a FIT-level question without requiring or replacing a full report."""
    if not question:
        return {"error": "missing_question", "message": "query_activity_detail requires a concrete question."}
    activity = _selected_activity(context)
    if not activity:
        return {"error": "missing_selected_activity", "message": "query_activity_detail requires a resolved activity."}

    return answer_focused_activity_question(activity, question=question, context=context, name=name)


def answer_focused_activity_question(
    activity: dict[str, Any],
    *,
    question: str,
    context: AgentContext | None = None,
    name: str = "query_activity_detail",
) -> dict[str, Any]:
    """Public focused-analysis boundary used by the unified analysis service."""
    summary, _ = read_activity_report(activity)
    return _answer_targeted_question(name, context, activity, summary or {}, question)


def _answer_targeted_question(
    name: str,
    context: AgentContext | None,
    activity: dict[str, Any],
    summary: dict[str, Any],
    user_request: str,
) -> dict[str, Any]:
    """Answer a new question without overwriting the cached full report."""
    fit_path = activity.get("fit_path") or summary.get("fit_path")
    if not fit_path:
        return {
            "error": "missing_fit_path",
            "message": "A focused activity question requires the original FIT file.",
        }

    analysis = run_activity_query_agent(str(fit_path), question=user_request)
    answer = str(analysis.get("answer") or "").strip()
    if not answer:
        return {
            "error": "missing_query_answer",
            "message": "Focused analysis did not return an answer.",
            "analysis": analysis,
        }
    return {
        "step": name,
        "status": "completed",
        "answer": answer,
        "result": {
            "schema_version": "activity_report.v1",
            "activity_key": analysis.get("activity_key") or activity.get("activity_key"),
            "fit_path": analysis.get("fit_path") or fit_path,
            "source": "targeted_query",
            "status": analysis.get("status"),
            "agent": "ActivityQueryAgent",
            "evidence": analysis.get("evidence") if isinstance(analysis.get("evidence"), list) else [],
            "limitations": analysis.get("limitations") if isinstance(analysis.get("limitations"), list) else [],
        },
    }


def _analyze_missing_summary(
    name: str,
    args: dict[str, Any],
    context: AgentContext,
    activity: dict[str, Any],
) -> dict[str, Any]:
    fit_path = activity.get("fit_path") or (str(context.current_fit_file) if context.current_fit_file else None)
    if not fit_path:
        return {
            "error": "missing_activity_summary",
            "message": "Selected activity does not have a readable summary report or FIT path.",
            "activity": activity,
        }

    analysis = run_activity_analysis_agent(
        str(fit_path),
        force=bool(args.get("force")),
        user_request=str(args.get("user_request") or ""),
    )
    report = str(analysis.get("markdown_report") or "").strip()
    if not report:
        return {
            "error": "missing_markdown_report",
            "message": "File analysis completed but did not return markdown_report.",
            "activity": activity,
            "analysis": analysis,
        }

    context.current_fit_file = Path(str(analysis.get("fit_path") or fit_path)).expanduser()
    context.current_activity_key = analysis.get("activity_key") or activity.get("activity_key")

    source = "analysis_agent_error" if analysis.get("analysis_error") else "generated_summary"
    return {
        "step": name,
        "status": "completed",
        "answer": report,
        "result": {
            "schema_version": "activity_report.v1",
            "activity_key": analysis.get("activity_key") or activity.get("activity_key"),
            "fit_path": analysis.get("fit_path") or fit_path,
            "source": source,
            "status": analysis.get("status"),
            "agent": analysis.get("agent"),
            "analysis_error": analysis.get("analysis_error") if isinstance(analysis.get("analysis_error"), dict) else None,
            "analysis_summary": analysis.get("analysis_summary") if isinstance(analysis.get("analysis_summary"), dict) else {},
        },
    }


def _selected_activity(context: AgentContext) -> dict[str, Any] | None:
    if context.selected_activities:
        first = context.selected_activities[0]
        return first if isinstance(first, dict) else None
    if context.current_fit_file or context.current_activity_key:
        return {
            "activity_key": context.current_activity_key,
            "fit_path": str(context.current_fit_file) if context.current_fit_file else None,
        }
    return None


def _fallback_report(summary: dict[str, Any]) -> str:
    analysis_summary = get_analysis_summary(summary)
    if not analysis_summary:
        return ""
    history_view = build_history_view(summary)
    lines = [
        f"# {analysis_summary.get('summary_label') or '活动报告'}",
        "",
        f"- 时间: {history_view.get('start_time_local') or history_view.get('start_time') or '未知'}",
        f"- 类型: {history_view.get('sport_type') or '未知'}",
        f"- 距离: {history_view.get('distance_km') or '未知'} km",
        f"- 时长: {history_view.get('duration_min') or '未知'} 分钟",
        f"- 主要刺激: {analysis_summary.get('main_stimulus') or '未知'}",
        f"- 负荷标签: {analysis_summary.get('load_label') or '未知'}",
    ]
    brief = analysis_summary.get("brief")
    if brief:
        lines.extend(["", str(brief)])
    return "\n".join(lines)


HANDLERS = {
    "analyze_activity": analyze_activity,
    "query_activity_detail": query_activity_detail,
}
