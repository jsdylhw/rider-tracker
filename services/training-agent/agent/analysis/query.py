"""Lightweight child agent for focused questions about one activity.

Full report generation intentionally remains in :mod:`agent.analysis.agent`.
This module returns only the answer and its evidence, so read-only questions do
not spend tokens generating a Strava description or a persistent report view.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent.runtime.chat_logger import append_chat_log, new_session_id
from agent.tools.fit_analysis import FIT_DATA_TOOLS, SUBMIT_QUERY_ANSWER_TOOL, build_tool_handlers
from agent.tools.spec import ToolRegistry
from fit.analysis.data import llm_safe_fit_summary
from fit.analysis.features import build_activity_features
from fit.analysis.metrics import build_activity_metrics
from services.activity.fit_loader import parse_activity_fit as parse_fit
from integrations.llm import AnthropicMessagesClient, build_tool_result_block, extract_text
from project_paths import project_relative_or_absolute, resolve_project_path
from storage.repositories.activity import ActivityStore, file_content_key

MAX_QUERY_STEPS = 4
QUERY_MAX_TOKENS = 8192

_QUERY_SYSTEM_PROMPT = """\
You answer one focused question about one endurance activity.
Use only the supplied deterministic facts and tool evidence. Do not invent
unavailable samples, weather, route context, physiology, or causality.
Recorded zero power is a valid observation, not a missing sample. Do not infer
sensor failure from zeros or a downhill without altitude evidence.
For any time/distance-window question, call the corresponding FIT tool before
answering. Interpret 前五分钟 and 0–5分钟 as start_s=0,end_s=300. Preserve the
user's requested bucket_seconds (e.g. 5 or 10); otherwise choose a suitable
interval and state it. Bounds are inclusive; time is elapsed from the first FIT
record, including pauses, not moving time.
Choose view="summary" for whole-window statistics only, view="intervals" when
trends or per-bucket details are requested. Select requested metrics explicitly:
power, heart_rate, cadence, speed, altitude. Interval outputs use columns+rows;
all values within a row belong to the same bucket.
Use window_summary for whole-window averages, never average the bucket means.
Report valid/missing/zero counts separately. Null is unavailable, never zero.
Copy numeric evidence from tool outputs; if unavailable, explain the limitation.

This is not a full activity report. Keep the Chinese Markdown answer concise
for summary questions; explicit per-bucket detail may be longer. Do not write a Strava description and
do not produce a reusable activity analysis summary. When enough evidence is
available, call submit_query_answer exactly once with answer, evidence, and
limitations. Evidence must contain only objective values present in the input.
"""


def run_activity_query_agent(fit_path: str | Path, *, question: str) -> dict[str, Any]:
    """Answer one activity question without creating or replacing a report."""
    path = resolve_project_path(fit_path)
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix.lower() != ".fit":
        raise ValueError(f"Only .fit files are supported: {path}")
    if not str(question).strip():
        raise ValueError("A focused activity question must not be empty")

    activity_key = file_content_key(path)
    store = ActivityStore()
    activity = store.get_activity(activity_key)
    facts = store.get_facts(activity_key)
    parsed: dict[str, Any] | None = None
    if facts is None:
        # Direct FIT queries remain supported even before the file is indexed.
        parsed = parse_fit(path)
        facts = {
            "metrics": build_activity_metrics(
                parsed, activity_key=activity_key, fit_path=project_relative_or_absolute(path),
            ),
            "features": build_activity_features(
                parsed, activity_key=activity_key, fit_path=project_relative_or_absolute(path),
            ),
        }

    metrics = facts.get("metrics") if isinstance(facts.get("metrics"), dict) else {}
    features = facts.get("features") if isinstance(facts.get("features"), dict) else {}
    fit_summary = _fit_summary(metrics, activity)
    parsed_cache = parsed

    def load_parsed() -> dict[str, Any]:
        nonlocal parsed_cache
        if parsed_cache is None:
            parsed_cache = parse_fit(path)
        return parsed_cache

    handlers = build_tool_handlers(load_parsed, None)
    payload = build_query_payload(
        question=str(question),
        activity_key=activity_key,
        fit_summary=fit_summary,
        metrics=metrics,
        features=features,
    )
    result = _run_query_loop(
        payload,
        handlers=handlers,
    )
    result.update({
        "kind": "activity_query_answer",
        "status": "answered_query",
        "activity_key": activity_key,
        "fit_path": project_relative_or_absolute(path),
    })
    append_chat_log(
        str(result.pop("session_id")),
        {
            "event": "fit_activity_query",
            "status": "completed",
            "fit_path": str(path),
            "activity_key": activity_key,
            "question": str(question),
            "payload": payload,
            "answer": result,
        },
        file_stem=path.stem,
    )
    return result


def build_query_payload(
    *,
    question: str,
    activity_key: str,
    fit_summary: dict[str, Any],
    metrics: dict[str, Any],
    features: dict[str, Any],
) -> dict[str, Any]:
    """Provide stored facts; the model requests raw windows through tools."""
    payload = {
        "question": question.strip(),
        "activity": {
            "activity_key": activity_key,
            "fit_summary": llm_safe_fit_summary(fit_summary),
        },
        "activity_metrics": metrics,
        "activity_features": features,
        "completion_contract": {
            "tool": "submit_query_answer",
            "fields": ["answer", "evidence", "limitations"],
        },
    }
    return payload


def _run_query_loop(
    payload: dict[str, Any], *, handlers: dict[str, Any],
) -> dict[str, Any]:
    client = AnthropicMessagesClient()
    session_id = new_session_id("fit_query")
    tools = (*tuple(tool for tool in FIT_DATA_TOOLS if tool.name != "get_history"), SUBMIT_QUERY_ANSWER_TOOL)
    registry = ToolRegistry(tools)
    messages: list[dict[str, Any]] = [{
        "role": "user",
        "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str),
    }]
    last_response: dict[str, Any] | None = None

    for _ in range(MAX_QUERY_STEPS):
        response = client.create_messages(
            system=_QUERY_SYSTEM_PROMPT,
            messages=messages,
            max_tokens=QUERY_MAX_TOKENS,
            tools=registry.to_anthropic(),
        )
        if response.get("stop_reason") == "max_tokens":
            raise RuntimeError("FIT 查询回答达到输出上限而被截断；未将不完整内容作为结果。请缩小窗口或增大分桶间隔。")
        last_response = response
        messages.append({"role": "assistant", "content": response.get("content") or []})

        submission = next((
            block for block in response.get("content") or []
            if isinstance(block, dict) and block.get("type") == "tool_use"
            and block.get("name") == "submit_query_answer"
        ), None)
        if submission is not None:
            candidate = submission.get("input") if isinstance(submission.get("input"), dict) else {}
            if isinstance(candidate.get("answer"), str) and candidate["answer"].strip():
                return {
                    "answer": candidate["answer"].strip(),
                    "evidence": candidate.get("evidence") if isinstance(candidate.get("evidence"), list) else [],
                    "limitations": candidate.get("limitations") if isinstance(candidate.get("limitations"), list) else [],
                    "model": response.get("model"),
                    "session_id": session_id,
                }

        tool_results = []
        for block in response.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            handler = handlers.get(str(block.get("name") or ""))
            arguments = block.get("input") if isinstance(block.get("input"), dict) else {}
            if handler is None:
                output = {"error": "unknown_tool", "name": block.get("name")}
            else:
                try:
                    output = handler(**arguments)
                except Exception as exc:
                    output = {"error": type(exc).__name__, "message": str(exc)}
            tool_results.append(build_tool_result_block(
                block.get("id"), json.dumps(output, ensure_ascii=False, default=str),
            ))
        if tool_results:
            messages.append({"role": "user", "content": tool_results})
            continue

        # A plain-text response is accepted as a compatibility fallback, but
        # native submit_query_answer remains the preferred bounded contract.
        text = extract_text(response)
        if text:
            return {
                "answer": text,
                "evidence": [],
                "limitations": ["模型未返回结构化证据字段。"],
                "model": response.get("model"),
                "session_id": session_id,
            }
        messages.append({
            "role": "user",
            "content": "Call submit_query_answer with a concise answer, evidence, and limitations.",
        })

    raise RuntimeError(
        "Activity query agent did not return submit_query_answer within "
        f"{MAX_QUERY_STEPS} steps; last_response_id={(last_response or {}).get('id')}"
    )


def _fit_summary(metrics: dict[str, Any], activity: dict[str, Any] | None) -> dict[str, Any]:
    identity = metrics.get("identity") if isinstance(metrics.get("identity"), dict) else {}
    scale = metrics.get("scale") if isinstance(metrics.get("scale"), dict) else {}
    activity = activity or {}
    duration_min = scale.get("duration_min")
    distance_km = scale.get("distance_km")
    return {
        "sport_type": identity.get("sport_type") or activity.get("sport_type"),
        "sub_sport": identity.get("sub_sport") or activity.get("sub_sport"),
        "start_time_local": identity.get("start_time_local") or activity.get("start_time_local"),
        "duration_s": float(duration_min) * 60 if duration_min is not None else activity.get("duration_s"),
        "distance_m": float(distance_km) * 1000 if distance_km is not None else activity.get("distance_m"),
    }
