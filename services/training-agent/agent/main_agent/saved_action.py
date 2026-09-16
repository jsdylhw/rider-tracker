"""Execute persisted retry or confirmation actions outside the LLM loop."""

from __future__ import annotations

import json
from typing import Any

from agent.main_agent.context import AgentContext
from agent.main_agent.execution_policy import TurnExecutionPolicy
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
    execution_policy: TurnExecutionPolicy | None = None,
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
        converter = getattr(exc, "to_tool_result", None)
        output = converter() if callable(converter) else {
            "error": type(exc).__name__, "message": str(exc),
        }

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
        code=str(payload["code"]) if payload.get("code") is not None else None,
        provider=str(payload["provider"]) if payload.get("provider") is not None else None,
        stage=str(payload["stage"]) if payload.get("stage") is not None else None,
        retryable=payload.get("retryable") if isinstance(payload.get("retryable"), bool) else None,
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

    from agent.main_agent.result_builder import build_completed_result, build_turn_result

    steps = [execution.to_step()]
    if execution_policy is not None and execution_policy.completion_tool_names:
        return build_completed_result(
            intent,
            context,
            label,
            step_count=1,
            max_tool_steps=1,
            steps=steps,
            execution_policy=execution_policy,
        )

    return build_turn_result(
        "failed" if failed else "completed",
        intent,
        context,
        steps,
        (
            f"重试 {tool_name} 仍未完成。\n{result_json[:200]}"
            if failed else f"已执行 {tool_name}。\n{result_json[:200]}"
        ),
    )
