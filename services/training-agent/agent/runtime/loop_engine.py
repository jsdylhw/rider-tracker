"""Provider-agnostic model/tool execution loop."""

from __future__ import annotations

import json
from time import perf_counter
from typing import Any, Callable

from integrations.llm import AnthropicMessagesClient, build_tool_result_block


def execute_tool_loop(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | Callable[[], list[dict[str, Any]]],
    handlers: dict[str, Any],
    runtime: Any,
    system: str = "",
    max_tokens: int = 4096,
    max_steps: int = 10,
    client: AnthropicMessagesClient | None = None,
) -> int:
    """Execute model/tool rounds and mutate ``messages`` in place."""
    client = client or AnthropicMessagesClient()
    step_count = 0

    while True:
        step_count += 1
        if step_count > max_steps:
            break

        reminder = runtime.before_llm_call()
        if isinstance(reminder, dict):
            messages.append(reminder)

        final_response_only = runtime.final_response_only
        current_tools = tools() if callable(tools) else tools
        response = client.create_messages(
            system=system,
            messages=messages,
            max_tokens=max_tokens,
            tools=[] if final_response_only else current_tools,
        )
        messages.append({"role": "assistant", "content": response.get("content") or []})

        if response.get("stop_reason") != "tool_use":
            runtime.on_loop_end(messages=messages, response=response, steps=step_count - 1)
            return step_count

        if final_response_only:
            messages.append({
                "role": "user",
                "content": "已有完整工具结果。不要再调用工具，直接用中文给出最终回答。",
            })
            continue

        runtime.on_tool_round()
        results: list[dict[str, Any]] = []
        terminal_completed_in_batch = False
        skill_activated_in_batch = False
        for block in response.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue

            if terminal_completed_in_batch or skill_activated_in_batch:
                terminal = terminal_completed_in_batch
                results.append(build_tool_result_block(
                    block["id"],
                    json.dumps({
                        "error": (
                            "terminal_result_already_produced"
                            if terminal else "skill_activation_requires_new_round"
                        ),
                        "message": (
                            "A terminal tool already completed in this response; this later call was not executed."
                            if terminal else
                            "The Skill was activated, but newly disclosed tools may only run in the next model round."
                        ),
                    }, ensure_ascii=False),
                ))
                continue

            blocked = runtime.pre_tool_use(block, step_count=step_count)
            if blocked:
                results.append(build_tool_result_block(
                    block["id"], json.dumps(blocked, ensure_ascii=False),
                ))
                continue

            handler = handlers.get(block["name"])
            tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
            tool_started = perf_counter()
            try:
                output = handler(tool_input, runtime.context) if handler else {
                    "error": "unknown_tool", "name": block["name"],
                }
            except Exception as exc:
                error_output = runtime.on_error(block, exc)
                output = error_output or {"error": type(exc).__name__, "message": str(exc)}

            from agent.main_agent.tool_result import is_failed_tool_output
            from observability import record_tool_call

            record_tool_call(
                name=str(block.get("name") or ""),
                arguments=tool_input,
                output=output,
                duration_ms=(perf_counter() - tool_started) * 1000,
                success=not is_failed_tool_output(output),
            )
            runtime.post_tool_use(block, output, step_count=step_count)
            terminal_completed_in_batch = runtime.final_response_only
            skill_activated_in_batch = (
                block.get("name") == "activate_skill"
                and isinstance(output, dict)
                and output.get("status") == "activated"
            )
            results.append(build_tool_result_block(
                block["id"], json.dumps(output, ensure_ascii=False, default=str),
            ))

        messages.append({"role": "user", "content": results})

        # Some terminal tools already return the complete user-facing answer
        # (for example a persisted activity report). Passing that answer back
        # through the main model adds cost and can replace it with stale
        # pre-tool commentary, so finish deterministically instead.
        terminal_answer = str(getattr(runtime, "terminal_answer", None) or "").strip()
        if terminal_answer:
            response = {
                "content": [{"type": "text", "text": terminal_answer}],
                "stop_reason": "end_turn",
            }
            messages.append({"role": "assistant", "content": response["content"]})
            runtime.on_loop_end(messages=messages, response=response, steps=step_count)
            return step_count

    return step_count
