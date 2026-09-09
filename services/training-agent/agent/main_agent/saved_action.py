"""Execute persisted retry or confirmation actions outside the LLM loop."""

from __future__ import annotations

import json
from typing import Any

from agent.main_agent.context import AgentContext
from agent.main_agent.tool_result import is_failed_tool_output, remember_failed_action
from agent.runtime.models import ToolExecution, TurnResult
from agent.tools.registry import TOOL_HANDLERS


def execute_saved_action(
    action: dict[str, Any],
    context: AgentContext,
    *,
    verbose: bool = False,
    intent: str,
    label: str,
) -> dict[str, Any]:
    tool_name = str(action.get("tool") or "")
    tool_input = action.get("input") if isinstance(action.get("input"), dict) else {}
    handler = TOOL_HANDLERS.get(tool_name)
    if not handler:
        answer = f"未知工具: {tool_name}"
        context.messages.append({"role": "assistant", "content": [{"type": "text", "text": answer}]})
        return TurnResult(
            answer=answer, status="failed", context=context, intent=intent,
            skill_id=context.active_skill_id,
            selected_activities=context.selected_activities,
            current_fit_file=str(context.current_fit_file) if context.current_fit_file else None,
        ).to_dict()

    try:
        output = handler(tool_input, context)
    except Exception as exc:
        output = {"error": type(exc).__name__, "message": str(exc)}

    context.last_tool_result = {"step_name": tool_name, "result": output}
    remember_failed_action(context, tool_name, tool_input, output)

    failed = is_failed_tool_output(output)
    payload = output if isinstance(output, dict) else {"result": output}
    execution = ToolExecution(
        index=0,
        tool=tool_name,
        input=tool_input,
        status=str(payload.get("status") or ("failed" if failed else "completed")),
        message=str(payload["message"]) if payload.get("message") is not None else None,
        error=str(payload["error"]) if payload.get("error") is not None else None,
        result=output,
    )
    context.execution_trace = [execution.to_dict()]
    result_json = json.dumps(output, ensure_ascii=False, default=str)
    context.messages.append({"role": "user", "content": f"[{label}] {tool_name}"})
    context.messages.append({
        "role": "assistant",
        "content": [{"type": "text", "text": f"已执行 {tool_name}:\n{result_json[:300]}"}],
    })
    if verbose:
        from agent.main_agent.hooks import _log
        _log(f"  [{label}] \033[1m{tool_name}\033[0m {result_json[:120]}")

    return TurnResult(
        answer=(
            f"重试 {tool_name} 仍未完成。\n{result_json[:200]}"
            if failed else f"已执行 {tool_name}。\n{result_json[:200]}"
        ),
        status="failed" if failed else "completed",
        context=context,
        intent=intent,
        skill_id=context.active_skill_id,
        executions=[execution],
        selected_activities=context.selected_activities,
        current_fit_file=str(context.current_fit_file) if context.current_fit_file else None,
    ).to_dict()
