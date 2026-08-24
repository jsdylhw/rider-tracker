"""Tool result helpers shared by hooks and direct turn-control paths."""

from __future__ import annotations

from typing import Any

from agent.main_agent.context import AgentContext


def remember_failed_action(
    context: AgentContext,
    tool_name: str,
    tool_input: dict[str, Any],
    output: Any,
) -> None:
    """Track the latest retryable failed action on the context."""
    if is_failed_tool_output(output):
        context.last_failed_action = {"tool": tool_name, "input": tool_input}
    elif tool_name == (context.last_failed_action or {}).get("tool"):
        context.last_failed_action = None


def is_failed_tool_output(output: Any) -> bool:
    if not isinstance(output, dict):
        return False
    if output.get("error") or output.get("status") == "failed":
        return True
    result = output.get("result")
    if isinstance(result, dict):
        upload_result = result.get("upload_result")
        if isinstance(upload_result, dict) and upload_result.get("error"):
            return True
        if result.get("error") or result.get("status") == "failed":
            return True
    return False
