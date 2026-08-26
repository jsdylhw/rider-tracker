"""Agent-facing activity range summaries."""

from __future__ import annotations

import json
from typing import Any

from agent.main_agent.context import AgentContext
from domain.analysis.artifacts import get_analysis_summary, get_index_load_label
from integrations.llm import AnthropicMessagesClient, extract_text
from storage.repositories.activity import ActivityStore


def summarize_activities(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return execute_summarize_activity_range("summarize_activities", args, context)


def generate_training_advice(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return summarize_activities(args, context)


def execute_summarize_activity_range(
    name: str,
    args: dict[str, Any],
    context: AgentContext,
    *,
    reason: str = "tool_use",
) -> dict[str, Any]:
    activities = [
        activity
        for activity in context.selected_activities
        if isinstance(activity, dict)
    ]
    scope = context.selected_activity_range or {}
    if not activities:
        answer = _empty_range_answer(scope)
        return {
            "step": name,
            "status": "completed",
            "answer": answer,
            "result": {
                "kind": "activity_range_summary",
                "count": 0,
                "scope": scope,
                "activities": [],
            },
        }

    normalized = [_compact_range_activity(activity) for activity in activities]
    total_distance = round(sum(float(item.get("distance_km") or 0) for item in normalized), 2)
    total_duration = round(sum(float(item.get("duration_min") or 0) for item in normalized), 1)
    result = {
        "kind": "activity_range_summary",
        "count": len(normalized),
        "scope": scope,
        "totals": {
            "distance_km": total_distance,
            "duration_min": total_duration,
        },
        "activities": normalized,
        # Range inspection is intentionally read-only. Missing full reports
        # remain visible; explicit report generation belongs to operations.
        "report_coverage": {
            "available_count": sum(1 for item in normalized if item.get("has_summary")),
            "missing_count": sum(1 for item in normalized if not item.get("has_summary")),
        },
    }
    answer = (
        _generate_range_ai_summary(result, activities, context, args, reason=reason)
        if _should_generate_ai_range_summary(args, reason=reason)
        else _format_range_summary_answer(result)
    )
    return {
        "step": name,
        "status": "completed",
        "answer": answer,
        "result": result,
    }


def empty_activity_selection_answer(selection_mode: str, result: dict[str, Any]) -> str | None:
    payload = result.get("result") if isinstance(result.get("result"), dict) else result
    if not isinstance(payload, dict):
        return None

    matched_count = payload.get("matched_count")
    count = payload.get("count")
    if matched_count != 0 and count != 0:
        return None

    if selection_mode == "range":
        start = payload.get("start_date")
        end = payload.get("end_date")
        if start and end:
            return f"{start} 到 {end} 没有找到已索引的活动。"
        return "这个时间范围内没有找到已索引的活动。"
    if selection_mode == "recent":
        return "没有找到已索引的最近活动。你可以先重建索引或同步 Garmin 活动。"
    return "没有找到符合条件的活动。你可以先重建索引，或确认日期、序号、活动名称是否正确。"


def _should_generate_ai_range_summary(args: dict[str, Any], *, reason: str = "") -> bool:
    mode = str(args.get("response_mode") or args.get("summary_mode") or "").lower()
    if mode in {"ai", "ai_summary", "llm", "llm_summary", "report"}:
        return True
    text = f"{reason} {args}".lower()
    return any(token in text for token in ("ai", "大模型", "总结报告", "详细", "整体情况", "整体分析"))


def _generate_range_ai_summary(
    summary: dict[str, Any],
    activities: list[dict[str, Any]],
    context: AgentContext,
    args: dict[str, Any] | None = None,
    *,
    reason: str = "",
) -> str:
    args = args or {}
    payload = {
        "user_message": _latest_user_message(context),
        "detail_level": str(args.get("detail_level") or "normal"),
        "range_summary": summary,
        "activity_details": [_activity_for_range_llm(activity) for activity in activities[:20]],
    }
    response = AnthropicMessagesClient().create_message(
        system=(
            "你是骑行训练分析助手.基于用户请求和本地已保存的活动简要报告,"
            "输出中文活动整体总结报告.不要编造未提供的数据;不要输出 JSON."
        ),
        user=json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        max_tokens=1800 if payload["detail_level"] == "detailed" else 1000,
        temperature=0.2,
    )
    text = extract_text(response)
    return text.strip() or _format_range_summary_answer(summary)


def _latest_user_message(context: AgentContext) -> str:
    for message in reversed(context.messages):
        if isinstance(message, dict) and message.get("role") == "user":
            return str(message.get("content") or "")
    return ""


def _activity_for_range_llm(activity: dict[str, Any]) -> dict[str, Any]:
    item = _compact_range_activity(activity)
    detail = _read_summary_detail(activity)
    if detail:
        item["summary_detail"] = detail
    return item


def _read_summary_detail(activity: dict[str, Any]) -> dict[str, Any]:
    activity_key = str(activity.get("activity_key") or "")
    data = ActivityStore().get_report_for_activity(activity) if activity_key else None
    if not isinstance(data, dict):
        return {}
    analysis_summary = get_analysis_summary(data)
    return {
        key: analysis_summary.get(key)
        for key in (
            "summary_label", "brief", "main_stimulus", "load_label", "quality_notes",
            "achievement", "limiter", "next_session_advice",
        )
        if analysis_summary.get(key) is not None
    }


def _compact_range_activity(activity: dict[str, Any]) -> dict[str, Any]:
    return {
        "activity_index": activity.get("activity_index"),
        "activity_key": activity.get("activity_key"),
        "file_name": activity.get("file_name"),
        "start_time_local": activity.get("start_time_local"),
        "date_local": activity.get("date_local"),
        "sport_type": activity.get("sport_type"),
        "duration_min": activity.get("duration_min"),
        "distance_km": activity.get("distance_km"),
        "has_summary": activity.get("has_summary"),
        "summary_label": activity.get("summary_label"),
        "main_stimulus": activity.get("main_stimulus"),
        "load_label": get_index_load_label(activity),
    }


def _format_range_summary_answer(summary: dict[str, Any]) -> str:
    scope = summary.get("scope") if isinstance(summary.get("scope"), dict) else {}
    totals = summary.get("totals") if isinstance(summary.get("totals"), dict) else {}
    lines = [
        f"{_range_title(scope)}找到 {summary.get('count')} 条已索引活动。",
        f"总量: {totals.get('distance_km', 0)} km, {totals.get('duration_min', 0)} 分钟。",
    ]
    for activity in summary.get("activities") or []:
        label = activity.get("summary_label") or activity.get("file_name") or activity.get("activity_key")
        lines.append(
            f"- #{activity.get('activity_index') or '?'} "
            f"{activity.get('start_time_local') or activity.get('date_local') or '未知时间'}: "
            f"{label}, {activity.get('distance_km') or 0} km / {activity.get('duration_min') or 0} 分钟"
        )
    return "\n".join(lines)


def _empty_range_answer(scope: dict[str, Any]) -> str:
    return f"{_range_title(scope)}没有找到已索引的活动。你可以先重建索引，或同步 Garmin 活动后再试。"


def _range_title(scope: dict[str, Any]) -> str:
    start = scope.get("start_date")
    end = scope.get("end_date")
    return f"{start} 到 {end} " if start and end else ""


HANDLERS = {
    "summarize_activities": summarize_activities,
    "generate_training_advice": generate_training_advice,
}
