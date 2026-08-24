"""Lightweight child agent for focused questions about one activity.

Full report generation intentionally remains in :mod:`agent.analysis.agent`.
This module returns only the answer and its evidence, so read-only questions do
not spend tokens generating a Strava description or a persistent report view.
"""

from __future__ import annotations

import json
import re
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
from settings import get_agent_config
from project_paths import project_relative_or_absolute, resolve_project_path
from storage.repositories.activity import ActivityStore, file_content_key

MAX_QUERY_STEPS = 4
QUERY_MAX_TOKENS = 1200

_NUMBER = r"\d+(?:\.\d+)?"
_TIME_RANGE_RE = re.compile(
    rf"(?P<start>{_NUMBER})\s*(?:-|–|—|到|至|~)\s*(?P<end>{_NUMBER})\s*"
    r"(?P<unit>秒|s\b|分钟|min\b|分\b)",
    re.IGNORECASE,
)
_DISTANCE_RANGE_RE = re.compile(
    rf"(?P<start>{_NUMBER})\s*(?:-|–|—|到|至|~)\s*(?P<end>{_NUMBER})\s*"
    r"(?P<unit>公里|km\b|千米|米\b|m\b)",
    re.IGNORECASE,
)

_QUERY_SYSTEM_PROMPT = """\
You answer one focused question about one endurance activity.
Use only the supplied deterministic facts and tool evidence. Do not invent
unavailable samples, weather, route context, physiology, or causality.
Zero recorded power with non-zero speed supports coasting or missing power,
not a downhill claim unless an altitude decrease is present in the evidence.

This is not a full activity report. Keep the Chinese Markdown answer concise
(normally under 700 Chinese characters). Do not write a Strava description and
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
    raw_request = parse_explicit_window(str(question))
    raw_evidence = None
    if raw_request is not None:
        # Numeric bounded windows are deterministic. Execute them before the
        # model call instead of spending a model round choosing obvious bounds.
        tool_name, arguments = raw_request
        raw_evidence = {
            "tool": tool_name,
            "arguments": arguments,
            "result": _compact_raw_evidence(
                handlers[tool_name](**arguments),
                tool_name=tool_name,
                question=str(question),
            ),
        }

    payload = build_query_payload(
        question=str(question),
        activity_key=activity_key,
        fit_summary=fit_summary,
        metrics=metrics,
        features=features,
        raw_evidence=raw_evidence,
    )
    result = _run_query_loop(
        payload,
        handlers=handlers,
        exact_window=raw_evidence is not None,
    )
    result.update({
        "schema_version": "activity_query_answer.v1",
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
            "exact_window": raw_request is not None,
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
    raw_evidence: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build a bounded query payload; exact windows do not need candidates."""
    payload = {
        "question": question.strip(),
        "activity": {
            "activity_key": activity_key,
            "fit_summary": llm_safe_fit_summary(fit_summary),
        },
        "activity_metrics": metrics,
        "raw_evidence": raw_evidence,
        "completion_contract": {
            "tool": "submit_query_answer",
            "fields": ["answer", "evidence", "limitations"],
        },
    }
    if raw_evidence is None:
        # Semantic questions may need the import-time sprint/effort/climb
        # candidates. Exact windows already have stronger local evidence.
        payload["activity_features"] = features
    return payload


def parse_explicit_window(question: str) -> tuple[str, dict[str, Any]] | None:
    """Parse common numeric bounded windows into deterministic FIT arguments."""
    time_match = _TIME_RANGE_RE.search(question)
    if time_match:
        start = float(time_match.group("start"))
        end = float(time_match.group("end"))
        if _is_minute_unit(time_match.group("unit")):
            start, end = start * 60, end * 60
        if end <= start:
            return None
        width = end - start
        return "get_time_intervals", {
            "bucket_seconds": max(1, min(30, round(width / 20))),
            "start_s": _clean_number(start),
            "end_s": _clean_number(end),
        }

    distance_match = _DISTANCE_RANGE_RE.search(question)
    if distance_match:
        start = float(distance_match.group("start"))
        end = float(distance_match.group("end"))
        if _is_kilometre_unit(distance_match.group("unit")):
            start, end = start * 1000, end * 1000
        if end <= start:
            return None
        width = end - start
        allowed = (100, 200, 500, 1000, 3000, 5000, 10000)
        wanted = max(100, width / 10)
        bucket = min(allowed, key=lambda value: abs(value - wanted))
        return "get_distance_intervals", {
            "bucket_distance_m": bucket,
            "start_d": _clean_number(start),
            "end_d": _clean_number(end),
        }
    return None


def _run_query_loop(
    payload: dict[str, Any], *, handlers: dict[str, Any], exact_window: bool,
) -> dict[str, Any]:
    if exact_window:
        # Bounds and interval aggregates are already deterministic here. The
        # model only formats a short evidence-backed answer, so hidden chain of
        # thought adds latency and tokens without improving data retrieval.
        config = dict(get_agent_config())
        config["thinking"] = "disabled"
        config.pop("reasoning_effort", None)
        client = AnthropicMessagesClient(config=config)
    else:
        client = AnthropicMessagesClient()
    session_id = new_session_id("fit_query")
    tools = (
        (SUBMIT_QUERY_ANSWER_TOOL,)
        if exact_window
        else (*tuple(tool for tool in FIT_DATA_TOOLS if tool.name != "get_history"), SUBMIT_QUERY_ANSWER_TOOL)
    )
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


def _compact_raw_evidence(
    result: dict[str, Any], *, tool_name: str, question: str,
) -> dict[str, Any]:
    """Drop interval columns unrelated to the focused question.

    Column arrays are aligned by index, so this filters whole columns rather
    than pruning individual null values. Metadata and the requested window are
    retained for traceability.
    """
    if not isinstance(result, dict) or not isinstance(result.get("series"), dict):
        return result
    common = {
        "start_s", "end_s", "duration_s", "distance_start_m", "distance_end_m",
        "avg_hr_bpm", "max_hr_bpm", "avg_cadence_rpm", "max_cadence_rpm",
    }
    text = str(question).lower()
    if tool_name == "get_time_intervals" or any(token in text for token in ("功率", "冲刺", "爆发", "power")):
        common.update({
            "avg_power_w", "avg_nonzero_power_w", "max_power_w", "power_w_zero_fraction",
            "avg_nonzero_cadence_rpm", "cadence_rpm_zero_fraction",
            "avg_speed_mps", "avg_nonzero_speed_mps", "max_speed_mps", "speed_mps_zero_fraction",
        })
    if tool_name == "get_distance_intervals" or any(token in text for token in ("爬坡", "海拔", "坡", "配速", "pace")):
        common.update({
            "distance_delta_m", "avg_speed_mps", "max_speed_mps", "avg_pace_s_per_km",
            "avg_altitude_m", "max_altitude_m", "avg_power_w", "max_power_w",
        })
    series = result["series"]
    return {
        key: value
        for key, value in result.items()
        if key != "series"
    } | {
        "series": {key: value for key, value in series.items() if key in common},
    }


def _is_minute_unit(unit: str) -> bool:
    return str(unit).lower() in {"分钟", "分", "min"}


def _is_kilometre_unit(unit: str) -> bool:
    return str(unit).lower() in {"公里", "千米", "km"}


def _clean_number(value: float) -> int | float:
    return int(value) if float(value).is_integer() else round(float(value), 3)
