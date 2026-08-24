"""Deterministic graders for routing, tool use, completion, and answers."""

from __future__ import annotations

import re
from typing import Any

from evaluation.schema import EvalCase


def grade_case(
    case: EvalCase,
    *,
    result: dict[str, Any],
    trace: dict[str, Any],
    input_price_per_million: float | None = None,
    output_price_per_million: float | None = None,
    cache_write_price_per_million: float | None = None,
    cache_read_price_per_million: float | None = None,
) -> dict[str, Any]:
    failures: list[str] = []
    intent_score = _grade_intent(case.expected.get("intent"), result.get("intent"), failures)
    skill_score = _grade_skill(case.expected, result.get("skill_id"), failures)
    tool_score = _grade_tools(case.expected, trace.get("tool_calls") or [], failures)
    completion_score = _grade_completion(case.expected.get("completion"), result, trace, failures)
    answer_score = _grade_answer(case.expected.get("answer_assertions"), str(result.get("answer") or ""), failures)
    scores = {
        "intent_accuracy": intent_score,
        "skill_selection": skill_score,
        "tool_selection": tool_score,
        "task_completion": completion_score,
        "answer_consistency": answer_score,
    }
    evaluated = [score for score in scores.values() if score is not None]
    usage = trace.get("usage") if isinstance(trace.get("usage"), dict) else {}
    cost = _token_cost(
        usage,
        input_price_per_million,
        output_price_per_million,
        cache_write_price_per_million,
        cache_read_price_per_million,
    )
    return {
        "passed": bool(evaluated) and all(score == 1.0 for score in evaluated),
        "scores": scores,
        "failures": failures,
        "latency_ms": trace.get("elapsed_ms"),
        "usage": usage,
        "estimated_cost_usd": cost,
    }


def _grade_intent(expected: Any, actual: Any, failures: list[str]) -> float | None:
    if expected is None:
        return None
    allowed = {str(value) for value in (expected if isinstance(expected, list) else [expected])}
    if str(actual) in allowed:
        return 1.0
    failures.append(f"intent expected {sorted(allowed)}, got {actual!r}")
    return 0.0


def _grade_skill(expected_fields: dict[str, Any], actual: Any, failures: list[str]) -> float | None:
    if "skill_id" not in expected_fields:
        return None
    expected = expected_fields.get("skill_id")
    if expected == actual:
        return 1.0
    failures.append(f"skill expected {expected!r}, got {actual!r}")
    return 0.0


def _grade_tools(expected: dict[str, Any], calls: list[dict[str, Any]], failures: list[str]) -> float | None:
    required = expected.get("required_tools") or []
    forbidden = [str(name) for name in expected.get("forbidden_tools") or []]
    ordered = [str(name) for name in expected.get("ordered_tools") or []]
    if not required and not forbidden and not ordered:
        return None
    checks: list[bool] = []
    for requirement in required:
        if isinstance(requirement, str):
            requirement = {"name": requirement}
        name = str(requirement.get("name") or "")
        matches = [call for call in calls if call.get("name") == name]
        matched = any(_matches_arguments(call.get("arguments") or {}, requirement.get("arguments") or {}) for call in matches)
        checks.append(matched)
        if not matched:
            failures.append(f"required tool not satisfied: {name} {requirement.get('arguments') or {}}")
    actual_names = [str(call.get("name") or "") for call in calls]
    for name in forbidden:
        absent = name not in actual_names
        checks.append(absent)
        if not absent:
            failures.append(f"forbidden tool called: {name}")
    if ordered:
        positions = []
        cursor = 0
        for name in ordered:
            try:
                index = actual_names.index(name, cursor)
            except ValueError:
                positions = []
                break
            positions.append(index)
            cursor = index + 1
        valid = len(positions) == len(ordered)
        checks.append(valid)
        if not valid:
            failures.append(f"tool order expected {ordered}, got {actual_names}")
    return sum(checks) / len(checks) if checks else None


def _grade_completion(
    expected: Any,
    result: dict[str, Any],
    trace: dict[str, Any],
    failures: list[str],
) -> float | None:
    if not isinstance(expected, dict):
        return None
    checks: list[bool] = []
    allowed_statuses = expected.get("result_status")
    if allowed_statuses is not None:
        allowed = {str(value) for value in (allowed_statuses if isinstance(allowed_statuses, list) else [allowed_statuses])}
        valid = str(result.get("status")) in allowed
        checks.append(valid)
        if not valid:
            failures.append(f"result status expected {sorted(allowed)}, got {result.get('status')!r}")
    tool_calls = trace.get("tool_calls") or []
    for assertion in expected.get("tool_results") or []:
        name = str(assertion.get("name") or "")
        matching = [call for call in tool_calls if call.get("name") == name]
        value_matches = any(
            _value_at(call.get("output"), str(assertion.get("path") or "status")) == assertion.get("equals")
            for call in matching
        )
        checks.append(value_matches)
        if not value_matches:
            failures.append(
                f"tool result {name}.{assertion.get('path') or 'status'} != {assertion.get('equals')!r}"
            )
    if expected.get("all_tools_successful"):
        valid = all(bool(call.get("success")) for call in tool_calls)
        checks.append(valid)
        if not valid:
            failures.append("one or more tool calls failed")
    return sum(checks) / len(checks) if checks else None


def _grade_answer(assertions: Any, answer: str, failures: list[str]) -> float | None:
    if not isinstance(assertions, list) or not assertions:
        return None
    checks: list[bool] = []
    for assertion in assertions:
        operation = str(assertion.get("op") or "contains")
        value = str(assertion.get("value") or "")
        if operation == "contains":
            valid = value in answer
        elif operation == "not_contains":
            valid = value not in answer
        elif operation == "regex":
            valid = re.search(value, answer) is not None
        else:
            raise ValueError(f"unsupported answer assertion: {operation}")
        checks.append(valid)
        if not valid:
            failures.append(f"answer assertion failed: {operation} {value!r}")
    return sum(checks) / len(checks)


def _matches_arguments(actual: dict[str, Any], expected: dict[str, Any]) -> bool:
    for key, matcher in expected.items():
        if key not in actual:
            return False
        value = actual[key]
        if isinstance(matcher, dict) and set(matcher).intersection({"contains", "one_of", "present"}):
            if "present" in matcher and bool(matcher["present"]) != (value is not None):
                return False
            if "contains" in matcher and matcher["contains"] not in value:
                return False
            if "one_of" in matcher and value not in matcher["one_of"]:
                return False
        elif value != matcher:
            return False
    return True


def _value_at(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _token_cost(
    usage: dict[str, Any],
    input_price_per_million: float | None,
    output_price_per_million: float | None,
    cache_write_price_per_million: float | None,
    cache_read_price_per_million: float | None,
) -> float | None:
    if input_price_per_million is None or output_price_per_million is None:
        return None
    cache_write_tokens = float(usage.get("cache_creation_input_tokens") or 0)
    cache_read_tokens = float(usage.get("cache_read_input_tokens") or 0)
    if cache_write_tokens and cache_write_price_per_million is None:
        return None
    if cache_read_tokens and cache_read_price_per_million is None:
        return None
    value = (
        float(usage.get("input_tokens") or 0) * input_price_per_million
        + float(usage.get("output_tokens") or 0) * output_price_per_million
        + cache_write_tokens * float(cache_write_price_per_million or 0)
        + cache_read_tokens * float(cache_read_price_per_million or 0)
    ) / 1_000_000
    return round(value, 8)
