"""FIT 分析子 Agent 的只读工具 handler."""

from __future__ import annotations

from typing import Any, Callable

from fit.analysis.stats import prune_empty_values

from .catalog import FIT_DATA_TOOLS
from fit.analysis.data import (
    get_activity_overview_tool,
    get_activity_summary_tool,
    detect_sprints_tool,
    get_distance_intervals_tool,
    get_running_efficiency_tool,
    get_time_intervals_tool,
    llm_safe_history,
    scan_activity_segments_tool,
)


def fit_data_tool_catalog() -> list[dict[str, Any]]:
    """返回可供 LLM 消费的工具目录(兼容旧接口,逐步迁移到 ToolRegistry)."""
    return [t.to_anthropic() for t in FIT_DATA_TOOLS]


fit_analysis_tool_catalog = fit_data_tool_catalog


def build_tool_handlers(
    parsed: dict[str, Any] | Callable[[], dict[str, Any]],
    history_before: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build child handlers, resolving the FIT only when a raw tool is used.

    ``parsed`` remains accepted for compatibility with direct unit callers.
    Production analysis passes a loader so facts-only reports do not pay FIT
    parsing cost unless the child actually requests local raw evidence.
    """
    cached: dict[str, Any] | None = parsed if isinstance(parsed, dict) else None

    def _parsed() -> dict[str, Any]:
        nonlocal cached
        if cached is None:
            cached = parsed()
        return cached

    def _overview():
        return get_activity_overview_tool(_parsed())

    def _summary(sections=None):
        return get_activity_summary_tool(_parsed(), sections=sections)

    def _segments(window_seconds=30, step_seconds=10, max_segments=12):
        return scan_activity_segments_tool(
            _parsed(),
            window_seconds=int(window_seconds),
            step_seconds=int(step_seconds),
            max_segments=int(max_segments),
        )

    def _sprints(max_segments=12):
        return detect_sprints_tool(_parsed(), max_segments=int(max_segments))

    def _time_intervals(bucket_seconds=60, start_s=None, end_s=None):
        return get_time_intervals_tool(
            _parsed(),
            bucket_seconds=int(bucket_seconds),
            start_s=start_s,
            end_s=end_s,
        )

    def _distance_intervals(bucket_distance_m=1000, start_d=None, end_d=None):
        return get_distance_intervals_tool(
            _parsed(),
            bucket_distance_m=int(bucket_distance_m),
            start_d=start_d,
            end_d=end_d,
        )

    def _running_efficiency():
        return get_running_efficiency_tool(_parsed())

    def _history():
        return llm_safe_history(history_before) or {
            "kind": "file_training_history",
            "count": 0,
            "activities": [],
            "note": "History was not enabled or no previous activities exist.",
        }

    return {
        "get_activity_overview": _overview,
        "get_activity_summary": _summary,
        "scan_activity_segments": _segments,
        "detect_sprints": _sprints,
        "get_time_intervals": _time_intervals,
        "get_distance_intervals": _distance_intervals,
        "get_running_efficiency": _running_efficiency,
        "get_history": _history,
    }


def call_fit_analysis_tool(
    name: str,
    arguments: dict[str, Any],
    *,
    parsed: dict[str, Any] | None = None,
    history_before: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """将 LLM 的单活动 FIT 工具调用路由到对应只读实现(兼容旧接口)."""
    if parsed is None and name != "get_history":
        return {
            "tool": name,
            "arguments": arguments,
            "error": "missing_parsed",
            "message": "This tool requires a parsed FIT file.",
        }

    handlers = build_tool_handlers(parsed, history_before)
    handler = handlers.get(name)
    if handler is None:
        return {"tool": name, "arguments": arguments, "error": "unknown_tool"}

    try:
        result = handler(**{k: v for k, v in arguments.items() if v is not None})
        return {"tool": name, "arguments": arguments, "result": prune_empty_values(result)}
    except Exception as exc:
        return {
            "tool": name,
            "arguments": arguments,
            "error": type(exc).__name__,
            "message": str(exc),
        }
