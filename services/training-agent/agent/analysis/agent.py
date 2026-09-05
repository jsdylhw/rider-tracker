"""Single-activity child agent backed by the SQLite report store."""

from __future__ import annotations

import hashlib
import json
import random
import re
from pathlib import Path
from typing import Any

from agent.runtime.chat_logger import append_chat_log, new_session_id, readable_chat_log_path
from integrations.llm import AnthropicMessagesClient, build_tool_result_block, extract_text
from agent.analysis.prompts import build_fit_analysis_system_prompt
from agent.tools import build_tool_handlers
from agent.tools.fit_analysis import FIT_ANALYSIS_TOOLS
from agent.tools.spec import ToolRegistry
from project_paths import project_relative_or_absolute, resolve_project_path
from storage.repositories.activity import ActivityStore
from fit.analysis.data import llm_safe_fit_summary, llm_safe_history
from fit.analysis.metrics import build_activity_metrics
from domain.analysis.artifacts import (
    SUMMARY_SCHEMA_V2,
    analysis_summary_from_submission,
    get_analysis_summary,
)
from services.activity.fit_loader import parse_activity_fit as parse_fit

STRAVA_SUMMARY_TONES: list[dict[str, str]] = [
    {
        "name": "training_log",
        "description": "正常训练日志口吻:朴素,克制,像 Strava 日志,重点写本次训练刺激,节奏和身体反馈.",
        "weight": 2,
    },
    {
        "name": "professional_coach",
        "description": "专业教练口吻:直接给训练判断和下一步建议,语气理性,尽量少用玩笑.",
        "weight": 2,
    },
    {
        "name": "minimal_brief",
        "description": "简洁复盘口吻:短句,高信息密度,读起来干净利落,适合直接贴到 Strava.",
        "weight": 2,
    },
    {
        "name": "soft_catgirl",
        "description": "猫娘口吻:可爱,轻快,带一点鼓励,但保持训练判断清楚,不要每句都卖萌.",
        "weight": 10,
    },
]

MAX_TOOL_LOOP_STEPS = 8


def run_activity_analysis_agent(
    fit_path: str,
    *,
    force: bool = False,
    user_request: str = "",
    persist: bool = True,
    use_history: bool = False,
) -> dict[str, Any]:
    """Analyze one FIT file through ActivityAnalysisAgent.

    The important contract is that failures are returned as structured analysis
    results instead of escaping as tool errors to the main agent.
    """
    try:
        result = analyze_fit_file(
            fit_path,
            use_history=use_history,
            force=force,
            user_request=user_request,
            persist=persist,
        )
    except Exception as exc:
        return _analysis_error_result(fit_path, exc, user_request=user_request)

    return _compact_analysis_result(result)


def analyze_fit_file(
    fit_path: str | Path,
    *,
    use_history: bool = False,
    force: bool = False,
    user_request: str = "",
    persist: bool = True,
    activity_key: str | None = None,
    database_path: str | Path | None = None,
) -> dict[str, Any]:
    """Analyze one FIT file through an independent child-agent session."""
    path = resolve_project_path(fit_path)
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix.lower() != ".fit":
        raise ValueError(f"Only .fit files are supported: {path}")

    store = ActivityStore(database_path)
    if activity_key is not None:
        indexed = store.get_activity(activity_key)
        if not indexed or resolve_project_path(indexed.get("fit_path") or "") != path:
            raise ValueError("Requested activity does not own this FIT file.")
    else:
        activity_key = _activity_key(path)
    previous_summary = store.get_report(activity_key)
    # A focused question must reach the child agent even if a generic summary
    # already exists.  The caller can set persist=False to keep that answer
    # read-only and avoid replacing the cached full report.
    if previous_summary and not force and not user_request.strip():
        result = previous_summary
        if result.get("schema_version") == SUMMARY_SCHEMA_V2:
            _sanitize_result_times(result)
            result["status"] = "skipped_existing_summary"
            return result

    facts = store.get_facts(activity_key)
    activity = store.get_activity(activity_key)
    parsed: dict[str, Any] | None = None
    facts_were_ephemeral = False
    if facts is None:
        # Focused read-only analysis can be requested for an unimported FIT.
        # Build equivalent facts in memory; persistent calls save them below.
        from fit.analysis.features import build_activity_features

        parsed = parse_fit(path)
        facts_were_ephemeral = True
        facts = {
            "metrics": build_activity_metrics(
                parsed,
                activity_key=activity_key,
                fit_path=project_relative_or_absolute(path),
            ),
            "features": build_activity_features(
                parsed,
                activity_key=activity_key,
                fit_path=project_relative_or_absolute(path),
            ),
        }
    fit_summary = (
        dict(parsed.get("summary") or {})
        if parsed is not None
        else _fit_summary_from_facts(facts, activity)
    )
    history_before = (
        store.query_history(
            before=fit_summary.get("start_time_local") or fit_summary.get("start_time"),
            days=90,
            limit=50,
        )
        if use_history
        else None
    )
    model_result = analyze_with_llm(
        path,
        parsed,
        history_before=history_before,
        user_request=user_request,
        facts=facts,
        fit_summary=fit_summary,
    )
    analysis_submission = normalize_analysis_submission(model_result.get("analysis_summary") or {})

    activity_metrics = facts.get("metrics") if isinstance(facts.get("metrics"), dict) else {}
    result = {
        "schema_version": SUMMARY_SCHEMA_V2,
        "status": "analyzed" if persist else "analyzed_query",
        "activity_key": activity_key,
        "fit_path": project_relative_or_absolute(path),
        "fit_summary": llm_safe_fit_summary(fit_summary),
        "activity_metrics": activity_metrics,
        "activity_features": facts.get("features") if isinstance(facts.get("features"), dict) else {},
        "analysis_summary": analysis_summary_from_submission(analysis_submission),
        "model": model_result.get("model"),
        "session_id": model_result.get("session_id"),
        "log_path": model_result.get("log_path"),
        "readable_log_path": model_result.get("readable_log_path"),
        "strava_summary_tone": model_result.get("strava_summary_tone"),
        "markdown_report": model_result["markdown_report"],
        "strava_summary": model_result["strava_summary"],
    }
    if history_before is not None:
        result["history_context"] = llm_safe_history(history_before)
    if persist:
        # Direct CLI/API analysis may start from an unindexed FIT.  Register the
        # immutable source row before enforcing the report foreign key.
        if store.get_activity(activity_key) is None:
            from storage.repositories.activity import entry_from_fit_summary

            if parsed is None:
                parsed = parse_fit(path)
                fit_summary = dict(parsed.get("summary") or fit_summary)
            store.upsert_activity(entry_from_fit_summary(path, parsed.get("summary") or {}))
        # A report may be generated directly from a FIT that was not imported
        # through Garmin/manual indexing.  Keep its deterministic facts in the
        # same durable store so later questions do not depend on report prose.
        if facts_were_ephemeral:
            from services.activity.catalog import persist_activity_facts

            if parsed is None:
                parsed = parse_fit(path)
            persist_activity_facts(
                parsed,
                activity_key=activity_key,
                fit_path=project_relative_or_absolute(path),
                path=database_path,
            )
        store.save_report(result)

    return result


def analyze_with_llm(
    path: Path,
    parsed: dict[str, Any] | None,
    *,
    history_before: dict[str, Any] | None,
    user_request: str = "",
    facts: dict[str, Any] | None = None,
    fit_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the child-agent FIT tool loop and return final structured analysis."""
    client = AnthropicMessagesClient()
    session_id = new_session_id("fit_analysis")
    strava_summary_tone = choose_strava_summary_tone()
    summary = dict(fit_summary or ((parsed or {}).get("summary") or {}))
    system_prompt = build_fit_analysis_system_prompt(summary.get("sport_type"))
    required_raw_tool = _required_raw_window_tool(user_request)
    analysis_tools = _analysis_tools_for_request(
        history_before=history_before,
        required_raw_tool=required_raw_tool,
    )
    registry = ToolRegistry(analysis_tools)
    handlers = build_tool_handlers(parsed if parsed is not None else lambda: parse_fit(path), history_before)

    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": json.dumps(
                build_initial_loop_payload(
                    path,
                    parsed,
                    history_before=history_before,
                    strava_summary_tone=strava_summary_tone,
                    user_request=user_request,
                    facts=facts,
                    fit_summary=summary,
                ),
                ensure_ascii=False,
                indent=2,
                default=str,
            ),
        }
    ]
    turns: list[dict[str, Any]] = []
    data: dict[str, Any] | None = None
    last_response: dict[str, Any] | None = None
    raw_window_tool_used = False

    for loop_step in range(1, MAX_TOOL_LOOP_STEPS + 1):
        response = client.create_messages(
            system=system_prompt,
            messages=messages,
            max_tokens=4000,
            tools=registry.to_anthropic(),
        )
        last_response = response
        response_text = extract_text(response)
        turns.append({
            "step": loop_step,
            "type": "llm_response",
            "raw_text": response_text,
            "response": response,
        })

        messages.append({"role": "assistant", "content": response.get("content") or []})

        submission = next(
            (
                block for block in (response.get("content") or [])
                if isinstance(block, dict) and block.get("type") == "tool_use"
                and block.get("name") == "submit_analysis"
            ),
            None,
        )
        if submission is not None:
            submitted_data = submission.get("input")
            candidate = submitted_data if isinstance(submitted_data, dict) else {}
            validation_error = _submission_validation_error(candidate)
            if validation_error is None and required_raw_tool and not raw_window_tool_used:
                validation_error = (
                    f"explicit raw window requires {required_raw_tool}; "
                    "call it with the requested bounds before submit_analysis"
                )
            if validation_error is None:
                data = candidate
                turns.append({"step": loop_step, "type": "analysis_submission", "tool": "submit_analysis"})
                break

            # Compatible backends occasionally emit a syntactically valid
            # submit_analysis call whose long report field is empty/truncated.
            # Reject it inside the tool loop so the model can repair the same
            # call instead of failing the whole activity after the loop exits.
            turns.append({
                "step": loop_step,
                "type": "invalid_analysis_submission",
                "tool": "submit_analysis",
                "error": validation_error,
            })
            messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": submission.get("id"),
                    "is_error": True,
                    "content": (
                        f"Invalid submit_analysis input: {validation_error}. "
                        "Call submit_analysis again with a concise but non-empty Chinese markdown_report, "
                        "non-empty strava_summary, and analysis_summary."
                    ),
                }],
            })
            continue

        tool_result_blocks: list[dict[str, Any]] = []
        for block in response.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            handler = handlers.get(block["name"])
            tool_input = block.get("input") or {}
            if handler is None:
                output = json.dumps({"error": "unknown_tool", "name": block["name"]})
            else:
                try:
                    result = handler(**tool_input)
                    output = json.dumps(result, ensure_ascii=False, default=str)
                except Exception as exc:
                    output = json.dumps({"error": type(exc).__name__, "message": str(exc)})
            tool_result_blocks.append(build_tool_result_block(block["id"], output))
            turns.append({"step": loop_step, "type": "tool_result", "tool": block["name"]})
            if block["name"] == required_raw_tool:
                raw_window_tool_used = True

        if tool_result_blocks:
            messages.append({"role": "user", "content": tool_result_blocks})
            continue

        if response_text:
            try:
                action = _extract_json_object(response_text)
            except (json.JSONDecodeError, RuntimeError):
                messages.append({
                    "role": "user",
                    "content": "Please continue. Call a data tool if needed; otherwise call submit_analysis with the final report.",
                })
                continue

            if action.get("action") == "final" or "markdown_report" in action:
                data = action.get("result") if isinstance(action.get("result"), dict) else action
                break

        messages.append({
            "role": "user",
                    "content": "Please call a data tool to get data, or call submit_analysis once you have enough data.",
        })

    if data is None:
        _write_analysis_log(
            session_id=session_id,
            path=path,
            history_before=history_before,
            strava_summary_tone=strava_summary_tone,
            system_prompt=system_prompt,
            messages=messages,
            turns=turns,
            parsed_response=None,
            status="failed",
            error={"type": "RuntimeError", "message": "LLM did not return final analysis within tool-loop steps"},
        )
        raise RuntimeError("LLM did not return final analysis within tool-loop steps")

    validation_error = _submission_validation_error(data)
    if validation_error is not None:
        _write_analysis_log(
            session_id=session_id,
            path=path,
            history_before=history_before,
            strava_summary_tone=strava_summary_tone,
            system_prompt=system_prompt,
            messages=messages,
            turns=turns,
            parsed_response=data,
            status="failed",
            error={"type": "RuntimeError", "message": validation_error},
        )
        raise RuntimeError(validation_error)
    data["model"] = (last_response or {}).get("model")
    data["raw_response_id"] = (last_response or {}).get("id")
    data["strava_summary_tone"] = strava_summary_tone
    log_path = _write_analysis_log(
        session_id=session_id,
        path=path,
        history_before=history_before,
        strava_summary_tone=strava_summary_tone,
        system_prompt=system_prompt,
        messages=messages,
        turns=turns,
        parsed_response=data,
        status="completed",
    )
    data["session_id"] = session_id
    data["log_path"] = str(log_path)
    data["readable_log_path"] = str(readable_chat_log_path(log_path))
    return data


def build_initial_loop_payload(
    path: Path,
    parsed: dict[str, Any] | None,
    *,
    history_before: dict[str, Any] | None,
    strava_summary_tone: dict[str, str],
    user_request: str = "",
    facts: dict[str, Any] | None = None,
    fit_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the first user message for the child-agent tool loop."""
    return {
        "instruction": (
            "You are in an independent ActivityAnalysisAgent session. The main agent has already resolved "
            "the activity. Analyze only this FIT file. Use the available read-only FIT data tools when needed. "
            "When user_request is non-empty, answer that question explicitly and use focused intervals or scans "
            "when the question asks about a specific period or effort. "
            "When done, call submit_analysis with markdown_report, strava_summary, and analysis_summary."
        ),
        "completion_contract": {
            "tool": "submit_analysis",
            "markdown_report": "Chinese markdown report.",
            "strava_summary": "About 200 Chinese characters for Strava. Follow strava_summary_style.",
            "analysis_summary": "Compact qualitative judgement for future comparisons.",
        },
        "strava_summary_style": strava_summary_tone,
        "user_request": user_request.strip(),
        "fit_file": {"path": str(path), "name": path.name, "activity_key": _activity_key(path)},
        "fit_summary": llm_safe_fit_summary(fit_summary or ((parsed or {}).get("summary") or {})),
        "activity_metrics": facts.get("metrics") if isinstance(facts, dict) and isinstance(facts.get("metrics"), dict) else build_activity_metrics(parsed or {}, activity_key=_activity_key(path), fit_path=project_relative_or_absolute(path)),
        "activity_features": facts.get("features") if isinstance(facts, dict) and isinstance(facts.get("features"), dict) else _build_ephemeral_features(parsed or {}, path),
        "history_available": history_before is not None,
    }


def _fit_summary_from_facts(facts: dict[str, Any], activity: dict[str, Any] | None) -> dict[str, Any]:
    """Build the child payload identity without parsing an already-indexed FIT."""
    metrics = facts.get("metrics") if isinstance(facts.get("metrics"), dict) else {}
    identity = metrics.get("identity") if isinstance(metrics.get("identity"), dict) else {}
    scale = metrics.get("scale") if isinstance(metrics.get("scale"), dict) else {}
    activity = activity or {}
    duration_min = scale.get("duration_min")
    distance_km = scale.get("distance_km")
    return {
        "sport_type": identity.get("sport_type") or activity.get("sport_type"),
        "sub_sport": identity.get("sub_sport") or activity.get("sub_sport"),
        "start_time_local": identity.get("start_time_local") or activity.get("start_time_local"),
        "duration_s": round(float(duration_min) * 60, 3) if duration_min is not None else activity.get("duration_s"),
        "distance_m": round(float(distance_km) * 1000, 3) if distance_km is not None else activity.get("distance_m"),
        "file_name": activity.get("file_name"),
    }


_TIME_WINDOW_RE = re.compile(
    r"(?:\d+|[一二三四五六七八九十]+)\s*(?:-|–|—|到|至|~)\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:秒|s\b|分钟|min\b|分\b)"
    r"|(?:前|后|最后|开始后)\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:秒|s\b|分钟|min\b|分\b)",
    re.IGNORECASE,
)
_DISTANCE_WINDOW_RE = re.compile(
    r"(?:\d+(?:\.\d+)?|[一二三四五六七八九十]+)\s*(?:-|–|—|到|至|~)\s*"
    r"(?:\d+(?:\.\d+)?|[一二三四五六七八九十]+)\s*(?:公里|km\b|千米|米\b)"
    r"|(?:前|后|最后)\s*\d+(?:\.\d+)?\s*(?:公里|km\b|千米|米\b)",
    re.IGNORECASE,
)


def _required_raw_window_tool(user_request: str) -> str | None:
    """Map an explicit user window to the sole fitting child FIT tool."""
    text = str(user_request or "")
    if _TIME_WINDOW_RE.search(text):
        return "get_time_intervals"
    if _DISTANCE_WINDOW_RE.search(text):
        return "get_distance_intervals"
    return None


def _analysis_tools_for_request(
    *, history_before: dict[str, Any] | None, required_raw_tool: str | None,
) -> tuple:
    """Expose the minimum child-tool set for the current analysis question.

    Exact windows intentionally receive exactly one matching raw query tool.
    This makes the evidence boundary visible and prevents a sprint candidate
    lookup from being substituted for a requested local measurement.
    """
    if required_raw_tool:
        return tuple(tool for tool in FIT_ANALYSIS_TOOLS if tool.name in {required_raw_tool, "submit_analysis"})
    if history_before is None:
        return tuple(tool for tool in FIT_ANALYSIS_TOOLS if tool.name != "get_history")
    return FIT_ANALYSIS_TOOLS


def _build_ephemeral_features(parsed: dict[str, Any], path: Path) -> dict[str, Any]:
    """Keep direct unit callers compatible when no imported facts are supplied."""
    from fit.analysis.features import build_activity_features

    return build_activity_features(parsed, activity_key=_activity_key(path), fit_path=project_relative_or_absolute(path))


def _submission_validation_error(data: dict[str, Any]) -> str | None:
    """Return a repairable completion-contract error, or None when valid."""
    if not isinstance(data.get("markdown_report"), str) or not data["markdown_report"].strip():
        return "LLM response must include non-empty markdown_report"
    if not isinstance(data.get("strava_summary"), str) or not data["strava_summary"].strip():
        return "LLM response must include non-empty strava_summary"
    if not isinstance(data.get("analysis_summary"), dict):
        return "LLM response must include analysis_summary object"
    return None


def choose_strava_summary_tone() -> dict[str, str]:
    """Weighted random Strava summary tone."""
    tone = random.choices(
        STRAVA_SUMMARY_TONES,
        weights=[int(tone.get("weight", 1)) for tone in STRAVA_SUMMARY_TONES],
        k=1,
    )[0]
    return {key: value for key, value in tone.items() if key != "weight"}


def normalize_analysis_submission(entry: dict[str, Any]) -> dict[str, Any]:
    """Keep only qualitative fields owned by the child agent."""
    normalized = dict(entry)
    normalized.setdefault("brief", "")
    return normalized


def _compact_analysis_result(result: dict[str, Any]) -> dict[str, Any]:
    from fit.analysis.stats import _meters_to_km, _seconds_to_minutes

    fit_summary = result.get("fit_summary") if isinstance(result.get("fit_summary"), dict) else {}
    return {
        "activity_key": result.get("activity_key"),
        "fit_path": result.get("fit_path"),
        "sport_type": fit_summary.get("sport_type"),
        "start_time_local": fit_summary.get("start_time_local"),
        "duration_min": _seconds_to_minutes(fit_summary.get("duration_s")),
        "distance_km": _meters_to_km(fit_summary.get("distance_m")),
        "markdown_report": result.get("markdown_report"),
        "strava_summary": result.get("strava_summary"),
        "analysis_summary": get_analysis_summary(result),
        "activity_metrics": result.get("activity_metrics") if isinstance(result.get("activity_metrics"), dict) else {},
        "model": result.get("model"),
        "status": result.get("status") or "analyzed",
        "agent": "ActivityAnalysisAgent",
    }


def _analysis_error_result(fit_path: str, exc: Exception, *, user_request: str = "") -> dict[str, Any]:
    path = Path(fit_path)
    message = str(exc)
    report = "\n".join([
        "# 活动分析暂时不可用",
        "",
        "ActivityAnalysisAgent 没能在本轮生成完整报告。",
        "",
        f"- FIT 文件: `{path}`",
        f"- 错误类型: `{type(exc).__name__}`",
        f"- 错误信息: {message}",
        "",
        "这通常是内部 FIT 分析 LLM 没有在限定轮次内返回最终报告。可以稍后重试，或先查看该活动的基础索引信息。",
    ])
    return {
        "activity_key": None,
        "fit_path": str(path),
        "markdown_report": report,
        "strava_summary": "",
        "status": "analysis_error",
        "agent": "ActivityAnalysisAgent",
        "analysis_error": {
            "type": type(exc).__name__,
            "message": message,
            "user_request": user_request,
        },
    }


def _sanitize_result_times(result: dict[str, Any]) -> None:
    fit_summary = result.get("fit_summary")
    if isinstance(fit_summary, dict):
        result["fit_summary"] = llm_safe_fit_summary(fit_summary)

    history_context = result.get("history_context")
    if isinstance(history_context, dict):
        result["history_context"] = llm_safe_history(history_context)


def _activity_key(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def _extract_json_object(text: str) -> dict[str, Any]:
    """Extract a JSON object from model text, including fenced JSON."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end < start:
            raise
        candidate = cleaned[start : end + 1]
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            data = _extract_final_jsonish_object(candidate)
    if not isinstance(data, dict):
        raise RuntimeError("LLM response must be a JSON object")
    return data


def _extract_final_jsonish_object(text: str) -> dict[str, Any]:
    """Parse the known final object shape when markdown contains raw quotes.

    Some Anthropic-compatible models produce a JSON fenced block but forget to
    escape quotes inside `markdown_report`. The final object contract is stable,
    so recover the fields by delimiter instead of discarding an otherwise valid
    analysis.
    """
    action = _extract_simple_json_string(text, "action") or "final"
    markdown_report = _extract_delimited_jsonish_string(text, "markdown_report", "strava_summary")
    strava_summary = _extract_delimited_jsonish_string(text, "strava_summary", "analysis_summary")
    analysis_summary = _extract_jsonish_object(text, "analysis_summary")
    if not markdown_report and not strava_summary:
        raise RuntimeError("LLM response must be a JSON object")
    return {
        "action": action,
        "markdown_report": markdown_report,
        "strava_summary": strava_summary,
        "analysis_summary": analysis_summary,
    }


def _extract_simple_json_string(text: str, key: str) -> str | None:
    import re

    match = re.search(rf'"{key}"\s*:\s*"([^"]*)"', text)
    return _decode_jsonish_string(match.group(1)) if match else None


def _extract_delimited_jsonish_string(text: str, key: str, next_key: str) -> str:
    import re

    pattern = rf'"{key}"\s*:\s*"'
    match = re.search(pattern, text)
    if not match:
        return ""
    start = match.end()
    next_match = re.search(rf'",\s*"{next_key}"\s*:', text[start:], flags=re.S)
    if not next_match:
        return ""
    return _decode_jsonish_string(text[start : start + next_match.start()])


def _extract_jsonish_object(text: str, key: str) -> dict[str, Any]:
    import re

    match = re.search(rf'"{key}"\s*:\s*', text)
    if not match:
        return {}
    start = text.find("{", match.end())
    if start < 0:
        return {}
    end = _matching_brace_end(text, start)
    if end < 0:
        return {}
    try:
        entry = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return entry if isinstance(entry, dict) else {}


def _matching_brace_end(text: str, start: int) -> int:
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def _decode_jsonish_string(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except json.JSONDecodeError:
        return (
            value
            .replace("\\r\\n", "\n")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace('\\"', '"')
            .replace("\\/", "/")
            .replace("\\\\", "\\")
        )


def _write_analysis_log(
    *,
    session_id: str,
    path: Path,
    history_before: dict[str, Any] | None,
    strava_summary_tone: dict[str, str],
    system_prompt: str,
    messages: list[dict[str, Any]],
    turns: list[dict[str, Any]],
    parsed_response: dict[str, Any] | None,
    status: str,
    error: dict[str, Any] | None = None,
) -> Path:
    event = {
        "event": "fit_analysis_tool_loop",
        "status": status,
        "fit_path": str(path),
        "activity_key": _activity_key(path),
        "history_included": history_before is not None,
        "strava_summary_tone": strava_summary_tone,
        "system": system_prompt,
        "messages": messages,
        "turns": turns,
        "parsed_response": parsed_response,
    }
    if error:
        event["error"] = error
    return append_chat_log(session_id, event, file_stem=path.stem)
