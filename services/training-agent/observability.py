"""Opt-in structured traces shared by agent, integrations, and evaluation.

Normal application runs do not allocate or persist traces.  Evaluation code
activates a trace through :func:`capture_agent_trace`; LLM clients and tool
loops then append timing and usage events through a ContextVar.  The same
context automatically covers nested activity-analysis agents.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Iterator
from uuid import uuid4


_CURRENT_TRACE: ContextVar["AgentTrace | None"] = ContextVar("agent_trace", default=None)


@dataclass
class AgentTrace:
    """One end-to-end agent run, including nested LLM and tool calls."""

    trace_id: str = field(default_factory=lambda: uuid4().hex)
    metadata: dict[str, Any] = field(default_factory=dict)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    llm_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    elapsed_ms: float | None = None
    _started: float = field(default_factory=perf_counter, repr=False)

    def finish(self) -> None:
        if self.elapsed_ms is None:
            self.elapsed_ms = round((perf_counter() - self._started) * 1000, 3)

    def usage_totals(self) -> dict[str, int]:
        keys = (
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        )
        totals = {
            key: sum(_non_negative_int(call.get("usage", {}).get(key)) for call in self.llm_calls)
            for key in keys
        }
        totals["total_tokens"] = sum(totals.values())
        return totals

    def to_dict(self) -> dict[str, Any]:
        self.finish()
        return {
            "schema_version": "agent_trace.v1",
            "trace_id": self.trace_id,
            "started_at": self.started_at,
            "elapsed_ms": self.elapsed_ms,
            "metadata": self.metadata,
            "usage": self.usage_totals(),
            "llm_calls": self.llm_calls,
            "tool_calls": self.tool_calls,
        }


@contextmanager
def capture_agent_trace(*, metadata: dict[str, Any] | None = None) -> Iterator[AgentTrace]:
    """Activate one trace for this execution context and all nested calls."""
    trace = AgentTrace(metadata=dict(metadata or {}))
    token = _CURRENT_TRACE.set(trace)
    try:
        yield trace
    finally:
        trace.finish()
        _CURRENT_TRACE.reset(token)


def current_agent_trace() -> AgentTrace | None:
    return _CURRENT_TRACE.get()


def record_llm_call(
    *,
    model: str,
    duration_ms: float,
    attempts: int,
    success: bool,
    usage: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    trace = current_agent_trace()
    if trace is None:
        return
    trace.llm_calls.append({
        "index": len(trace.llm_calls) + 1,
        "model": model,
        "duration_ms": round(float(duration_ms), 3),
        "attempts": max(1, int(attempts)),
        "success": bool(success),
        "usage": _normalized_usage(usage),
        **({"error": error} if error else {}),
    })


def record_tool_call(
    *,
    name: str,
    arguments: dict[str, Any],
    output: Any,
    duration_ms: float,
    success: bool,
) -> None:
    trace = current_agent_trace()
    if trace is None:
        return
    trace.tool_calls.append({
        "index": len(trace.tool_calls) + 1,
        "name": str(name),
        "arguments": dict(arguments),
        "duration_ms": round(float(duration_ms), 3),
        "success": bool(success),
        "output": output,
    })


def _normalized_usage(usage: dict[str, Any] | None) -> dict[str, int]:
    if not isinstance(usage, dict):
        return {}
    keys = (
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    )
    return {key: _non_negative_int(usage.get(key)) for key in keys if usage.get(key) is not None}


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0
