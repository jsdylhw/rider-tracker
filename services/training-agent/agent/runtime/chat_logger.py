"""对话日志:将 LLM 交互记录写入 log/ 目录的 JSONL + 可读 Markdown.

每次 LLM 调用追加一条日志。JSONL 适合程序读取,
同步生成同名 .md 文件方便人工查看 tool loop 过程。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from project_paths import runtime_paths


def new_session_id(prefix: str = "chat") -> str:
    """生成唯一 session ID:{prefix}_{UTC时间}_{随机8位hex}."""
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}_{timestamp}_{uuid4().hex[:8]}"


def append_chat_log(
    session_id: str, event: dict[str, Any], *, log_dir: str | Path | None = None,
    file_stem: str | None = None,
) -> Path:
    """追加一条事件记录到 JSONL 日志,同步更新 .md 可读日志.

    Args:
        session_id: 会话标识,记录在日志内容中.
        event: 要记录的事件 dict.
        log_dir: 日志目录,默认 log/.
        file_stem: 日志文件名(不含扩展名).有则用 {file_stem}.jsonl,无则用 {session_id}.jsonl.

    Returns:
        Path: JSONL 文件路径.
    """
    target_dir = Path(log_dir) if log_dir is not None else runtime_paths().log_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    name = file_stem or session_id
    path = target_dir / f"{name}.jsonl"
    record = {"logged_at": datetime.now(timezone.utc).isoformat(), **event}
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    append_readable_chat_log(path, record)
    return path


def readable_chat_log_path(path: str | Path) -> Path:
    """将 .jsonl 路径转为对应的 .md 路径."""
    source = Path(path)
    return source.with_suffix(".md")


def write_main_agent_markdown_log(
    session_id: str,
    *,
    user_message: str,
    tool_plan: dict[str, Any],
    execution: dict[str, Any],
    selected_activities: list[dict[str, Any]],
    selected_activity_range: dict[str, Any] | None,
    current_fit_file: str | None,
    log_dir: str | Path | None = None,
) -> Path:
    """写入 Main Agent 总览日志,只生成可读 Markdown,不再额外生成 JSONL。"""
    target_dir = Path(log_dir) if log_dir is not None else runtime_paths().log_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{session_id}.md"
    lines = _format_main_agent_log(
        session_id=session_id,
        user_message=user_message,
        tool_plan=tool_plan,
        execution=execution,
        selected_activities=selected_activities,
        selected_activity_range=selected_activity_range,
        current_fit_file=current_fit_file,
    )
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return path


def append_readable_chat_log(jsonl_path: Path, record: dict[str, Any]) -> Path:
    """追加一条可读事件到对应的 .md 日志."""
    path = readable_chat_log_path(jsonl_path)
    is_new = not path.exists()
    lines: list[str] = []
    if is_new:
        lines.extend([
            f"# Chat Log: {jsonl_path.stem}", "",
            f"- jsonl: `{jsonl_path}`", "",
        ])
    lines.extend(_format_record(record))
    with path.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip() + "\n\n")
    return path


def _format_record(record: dict[str, Any]) -> list[str]:
    event = str(record.get("event") or "event")
    logged_at = record.get("logged_at")
    lines = ["---", "", f"## {event}", "", f"- logged_at: `{logged_at}`"]
    for key in ["fit_path", "activity_key", "session_id"]:
        if record.get(key):
            lines.append(f"- {key}: `{record[key]}`")
    lines.append("")

    if event == "fit_analysis_tool_loop":
        lines.extend(_format_tool_loop(record))
        return lines

    lines.extend(_markdown_block("Record Summary", _compact_json(record)))
    return lines


def _format_main_agent_log(
    *,
    session_id: str,
    user_message: str,
    tool_plan: dict[str, Any],
    execution: dict[str, Any],
    selected_activities: list[dict[str, Any]],
    selected_activity_range: dict[str, Any] | None,
    current_fit_file: str | None,
) -> list[str]:
    status = execution.get("status")
    final_response = str(execution.get("final_response") or "").strip()
    lines = [
        f"# Main Agent Log: {session_id}",
        "",
        f"- logged_at: `{datetime.now(timezone.utc).isoformat()}`",
        f"- main_agent_status: `{status}`",
    ]
    if current_fit_file:
        lines.append(f"- current_fit_file: `{current_fit_file}`")
    lines.extend(["", "## User Request", "", user_message.strip() or "(empty)", ""])

    if final_response:
        lines.extend(["## Final Answer", "", final_response, ""])

    lines.extend(_main_agent_plan_section("Tool Plan", tool_plan))

    lines.extend(_main_agent_execution_section(execution, final_response=final_response))
    lines.extend(_main_agent_activity_section(selected_activities, selected_activity_range))
    return lines


def _main_agent_plan_section(title: str, plan: dict[str, Any]) -> list[str]:
    lines = [f"## {title}", ""]
    if plan.get("intent"):
        lines.append(f"- intent: `{plan.get('intent')}`")
    elif plan.get("task_type"):
        lines.append(f"- task_type: `{plan.get('task_type')}`")
    groups = plan.get("tool_groups")
    if groups:
        lines.append(f"- tool_groups: `{_inline_json(groups)}`")
    scope = plan.get("activity_scope")
    if scope:
        lines.append(f"- activity_scope: `{_inline_json(scope)}`")
    lines.append("")
    steps = plan.get("steps") if isinstance(plan.get("steps"), list) else []
    steps = [
        step for step in steps
        if not (isinstance(step, dict) and step.get("name") == "final_response")
    ]
    if not steps:
        lines.extend(["No steps.", ""])
        return lines
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            continue
        lines.append(f"### {index}. {step.get('name')}")
        reason = step.get("reason")
        if reason:
            lines.append(f"- reason: {reason}")
        arguments = step.get("arguments") if isinstance(step.get("arguments"), dict) else {}
        if arguments:
            lines.append(f"- arguments: `{_inline_json(arguments)}`")
        lines.append("")
    return lines


def _main_agent_execution_section(execution: dict[str, Any], *, final_response: str = "") -> list[str]:
    lines = ["## Execution", ""]
    step_results = execution.get("step_results") if isinstance(execution.get("step_results"), list) else []
    if not step_results and isinstance(execution.get("steps"), list):
        step_results = execution.get("steps") or []
    if not step_results:
        return lines + ["No executed steps.", ""]
    for result in step_results:
        if not isinstance(result, dict):
            continue
        if _is_redundant_final_response_step(result, final_response):
            continue
        index = int(result.get("index") or 0) + 1
        name = result.get("step_name") or result.get("tool")
        status = result.get("status")
        lines.append(f"### {index}. {name}")
        if status:
            lines.append(f"- status: `{status}`")
        if result.get("input"):
            lines.append(f"- input: `{_inline_json(result.get('input'))}`")
        if result.get("message"):
            lines.append(f"- message: {result.get('message')}")
        if result.get("error"):
            lines.append(f"- error: `{result.get('error')}`")
        before = result.get("navigation_before")
        after = result.get("navigation_after")
        if isinstance(before, dict) and isinstance(after, dict) and before != after:
            lines.append(f"- navigation: `{_inline_json(before)}` → `{_inline_json(after)}`")
        lines.extend(_main_agent_result_summary(result.get("result"), final_response=final_response))
        lines.append("")
    return lines


def _is_redundant_final_response_step(result: dict[str, Any], final_response: str) -> bool:
    if result.get("step_name") != "final_response":
        return False
    payload = result.get("result") if isinstance(result.get("result"), dict) else {}
    answer = str(payload.get("answer") or "").strip()
    return bool(answer and final_response and answer == final_response)


def _main_agent_result_summary(result: Any, *, final_response: str = "") -> list[str]:
    if not isinstance(result, dict):
        return []
    payload = result.get("result") if isinstance(result.get("result"), dict) else result
    lines: list[str] = []
    answer = result.get("answer")
    if isinstance(answer, str) and answer.strip() and answer.strip() != final_response:
        lines.extend(_markdown_block("Step Answer", answer))
    if not isinstance(payload, dict):
        return lines

    for key in ("count", "matched_count", "schema_version"):
        if payload.get(key) is not None:
            lines.append(f"- {key}: `{payload.get(key)}`")

    analyses = payload.get("analyses") if isinstance(payload.get("analyses"), list) else []
    if analyses:
        lines.append("- generated_reports:")
        for item in analyses:
            if not isinstance(item, dict):
                continue
            lines.append(
                "  - "
                + ", ".join(
                    part for part in [
                        f"fit=`{item.get('fit_path')}`" if item.get("fit_path") else "",
                        f"report=`{item.get('report_schema_version')}`" if item.get("report_schema_version") else "",
                        f"status=`{item.get('status')}`" if item.get("status") else "",
                    ] if part
                )
            )
    generation = payload.get("summary_generation") if isinstance(payload.get("summary_generation"), dict) else {}
    if generation:
        lines.extend(_summary_generation_lines(generation))
    activities = payload.get("activities") if isinstance(payload.get("activities"), list) else []
    if activities:
        lines.append("- activities:")
        for activity in activities[:20]:
            if isinstance(activity, dict):
                lines.append(f"  - {_activity_line(activity)}")
    return lines


def _summary_generation_lines(generation: dict[str, Any]) -> list[str]:
    lines = [
        "- summary_generation:",
        f"  - generated_count: `{generation.get('generated_count', 0)}`",
        f"  - skipped_count: `{generation.get('skipped_count', 0)}`",
    ]
    generated = generation.get("generated") if isinstance(generation.get("generated"), list) else []
    skipped = generation.get("skipped") if isinstance(generation.get("skipped"), list) else []
    if generated:
        lines.append("  - generated:")
        for item in generated:
            if isinstance(item, dict):
                lines.append(f"    - {_summary_generation_line(item)}")
    if skipped:
        lines.append("  - skipped:")
        for item in skipped:
            if isinstance(item, dict):
                lines.append(f"    - {_summary_generation_line(item)}")
    return lines


def _summary_generation_line(item: dict[str, Any]) -> str:
    parts = [
        f"activity=#{item.get('activity_index')}" if item.get("activity_index") is not None else "",
        f"status=`{item.get('status')}`" if item.get("status") else "",
        f"fit=`{item.get('fit_path')}`" if item.get("fit_path") else "",
        f"report=`{item.get('report_schema_version')}`" if item.get("report_schema_version") else "",
    ]
    return ", ".join(part for part in parts if part)


def _main_agent_activity_section(
    selected_activities: list[dict[str, Any]],
    selected_activity_range: dict[str, Any] | None,
) -> list[str]:
    lines = ["## Selected Activities", ""]
    if selected_activity_range:
        lines.append(f"- scope: `{_inline_json(selected_activity_range)}`")
    if not selected_activities:
        lines.extend(["No selected activities.", ""])
        return lines
    for activity in selected_activities:
        if not isinstance(activity, dict):
            continue
        lines.append(f"- {_activity_line(activity)}")
        if activity.get("fit_path"):
            lines.append(f"  - fit: `{activity.get('fit_path')}`")
    lines.append("")
    return lines


def _activity_line(activity: dict[str, Any]) -> str:
    label = activity.get("summary_label") or activity.get("file_name") or activity.get("activity_key") or "activity"
    started = activity.get("start_time_local") or activity.get("date_local") or "unknown_time"
    index = activity.get("activity_index") or "?"
    distance = activity.get("distance_km")
    duration = activity.get("duration_min")
    metrics = []
    if distance is not None:
        metrics.append(f"{distance} km")
    if duration is not None:
        metrics.append(f"{duration} min")
    suffix = f" ({', '.join(metrics)})" if metrics else ""
    return f"#{index} {started}: {label}{suffix}"


def _inline_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _format_tool_loop(record: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    tone = record.get("strava_summary_tone")
    if tone:
        lines.extend(_markdown_block("Strava Summary Tone", _compact_json(tone)))

    turns = record.get("turns") if isinstance(record.get("turns"), list) else []
    if turns:
        lines.extend(["### Tool Loop Steps", ""])
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            step = turn.get("step")
            kind = turn.get("type")
            lines.append(f"#### Step {step}: {kind}")
            lines.append("")
            if kind == "llm_response":
                parsed = turn.get("parsed")
                if isinstance(parsed, dict):
                    action = parsed.get("action")
                    tool = parsed.get("tool")
                    lines.append(f"- action: `{action}`")
                    if tool:
                        lines.append(f"- tool: `{tool}`")
                    if parsed.get("markdown_report"):
                        lines.extend(_markdown_block("Final Markdown Report", parsed.get("markdown_report")))
                    elif parsed.get("result") and isinstance(parsed["result"], dict):
                        result = parsed["result"]
                        if result.get("markdown_report"):
                            lines.extend(_markdown_block("Final Markdown Report", result.get("markdown_report")))
                else:
                    lines.extend(_markdown_block("Raw Response", turn.get("raw_text")))
            elif kind == "tool_result":
                lines.append(f"- tool: `{turn.get('tool')}`")
                if turn.get("error"):
                    lines.append(f"- error: `{turn.get('error')}`")
                result = turn.get("result")
                if result is not None:
                    lines.extend(_markdown_block("Result Preview", _preview_json(result)))
            lines.append("")

    parsed_response = record.get("parsed_response")
    if isinstance(parsed_response, dict):
        if parsed_response.get("markdown_report"):
            lines.extend(_markdown_block("Final Report", parsed_response.get("markdown_report")))
        if parsed_response.get("strava_summary"):
            lines.extend(_markdown_block("Strava Summary", parsed_response.get("strava_summary")))
    return lines


def _markdown_block(title: str, value: Any) -> list[str]:
    if value is None:
        return []
    text = str(value).strip()
    if not text:
        return []
    return [f"### {title}", "", text, ""]


def _compact_json(value: Any) -> str:
    return "```json\n" + json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n```"


def _preview_json(value: Any, limit: int = 1800) -> str:
    """JSON 预览,超长截断避免 .md 日志膨胀."""
    text = json.dumps(value, ensure_ascii=False, indent=2, default=str)
    if len(text) > limit:
        text = text[:limit].rstrip() + "\n... truncated"
    return "```json\n" + text + "\n```"
