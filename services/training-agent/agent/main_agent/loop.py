"""Agent tool-use loop.

agent_loop() — 纯 tool-use 循环, 接收 ToolLoopHooks 实例.
run_tool_loop() — 便捷入口: intent/context/handlers 组装.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from agent.runtime.chat_logger import new_session_id
from agent.main_agent.context import AgentContext
from agent.main_agent.execution_policy import TurnExecutionPolicy
from fit.paths import resolve_fit_path as _resolve_fit_path
from integrations.llm import AnthropicMessagesClient, LLMRequestError
from agent.runtime.loop_engine import execute_tool_loop
from agent.tools import MAIN_AGENT_TOOLS, render_anthropic_tools
from agent.main_agent.hooks import ToolLoopHooks
from agent.main_agent.prompt_builder import (
    build_skill_catalog_prompt,
    build_state_preamble,
    build_system_prompt,
)
from agent.main_agent.result_builder import (
    build_activation_unavailable_result,
    build_completed_result,
    build_llm_unavailable_result,
    intent_kind,
)
from agent.tools.registry import TOOL_HANDLERS
from agent.main_agent.turn_control import handle_control_turn
from agent.main_agent.turn_policy import tools_for_skill
from agent.main_agent.turn_policy import should_continue_route_skill
from agent.skills import get_skill, load_skill_instructions

MAX_TOOL_STEPS = 10


# -- 核心: agent_loop -------------------------------------------------

def agent_loop(*args, hooks: ToolLoopHooks, **kwargs) -> int:
    """Compatibility alias for evaluation callers; use execute_tool_loop."""
    return execute_tool_loop(*args, runtime=hooks, **kwargs)


# -- 便捷入口: run_tool_loop --------------------------------------------

def run_tool_loop(
    message: str,
    *,
    fit_path: str | Path | None = None,
    use_history: bool = True,
    max_tokens: int = 4096,
    verbose: bool = False,
    context: AgentContext | None = None,
    execution_policy: TurnExecutionPolicy | None = None,
) -> dict[str, Any]:
    """组装 intent/context/handlers → agent_loop()."""
    execution_policy = execution_policy or TurnExecutionPolicy.chat()
    context = _prepare_context(message, fit_path=fit_path, use_history=use_history, context=context)
    # Execution evidence belongs exclusively to this turn. Clear it before
    # control commands and client construction can return early.
    context.execution_trace = []

    if execution_policy.forced_skill_id:
        context.active_skill_id = execution_policy.forced_skill_id
    control_result = handle_control_turn(
        message,
        context,
        verbose=verbose,
        execution_policy=execution_policy,
    )
    if control_result is not None:
        if not execution_policy.is_satisfied(context.execution_trace):
            from agent.main_agent.result_builder import build_policy_unsatisfied_result

            steps = [
                {"tool": item.get("tool"), "input": item.get("input") or {}}
                for item in context.execution_trace
                if isinstance(item, dict)
            ]
            return build_policy_unsatisfied_result(context, steps, execution_policy)
        return control_result

    continue_route_skill = should_continue_route_skill(message, context)
    # Skill authority and sport references are scoped to one user turn.
    context.active_skill_id = None
    context.active_skill_confidence = 0.0
    context.active_skill_reason = None
    context.pending_skill_reference = None
    if execution_policy.forced_skill_id or continue_route_skill:
        context.active_skill_id = execution_policy.forced_skill_id or "plan-routes"
        context.active_skill_confidence = 1.0
        context.active_skill_reason = (
            "request_policy" if execution_policy.forced_skill_id else "continued_from_recent_skill"
        )
        context.last_used_skills = [context.active_skill_id]
        context.conversation_used_skills.append(context.active_skill_id)

    try:
        client = AnthropicMessagesClient()
    except (RuntimeError, ValueError) as exc:
        return build_activation_unavailable_result(
            context, error=exc, execution_policy=execution_policy,
        )

    try:
        step_count, steps_taken = _execute_main_agent_turn(
            message,
            context,
            verbose,
            max_tokens,
            client=client,
            execution_policy=execution_policy,
        )
    except LLMRequestError as exc:
        skill = get_skill(context.active_skill_id)
        intent = skill.public_intent if skill else "chat"
        return build_llm_unavailable_result(
            intent, context, steps=getattr(exc, "steps_taken", []), error=exc,
            execution_policy=execution_policy,
        )

    skill = get_skill(context.active_skill_id)
    intent = skill.public_intent if skill else "chat"
    return build_completed_result(
        intent,
        context,
        message,
        step_count=step_count,
        max_tool_steps=MAX_TOOL_STEPS,
        steps=steps_taken,
        execution_policy=execution_policy,
    )


def _prepare_context(
    message: str,
    *,
    fit_path: str | Path | None,
    use_history: bool,
    context: AgentContext | None,
) -> AgentContext:
    if context is not None:
        if context.workspace_id and not isinstance(context.analysis_navigation, dict):
            from agent.analysis.workspace import AnalysisNavigationService

            AnalysisNavigationService().load_into_context(context)
        context.messages.append({"role": "user", "content": message})
        return context

    current_fit = _resolve_fit_path(fit_path) if fit_path else None
    context = AgentContext(
        session_id=new_session_id("tool_loop"),
        workspace_id="default",
        current_fit_file=current_fit,
        history_enabled=use_history,
        messages=[{"role": "user", "content": message}],
    )
    from agent.analysis.workspace import AnalysisNavigationService

    AnalysisNavigationService().load_into_context(context)
    return context


def _execute_main_agent_turn(
    message,
    context,
    verbose,
    max_tokens,
    *,
    client=None,
    execution_policy: TurnExecutionPolicy | None = None,
):
    """执行 agent_loop 并同步 messages 回 context. 返回 step_count."""
    def allowed_tool_names() -> set[str]:
        skill = get_skill(context.active_skill_id)
        names = tools_for_skill(skill, message) if skill else {"activate_skill"}
        required = execution_policy.completion_tool_names
        # Exact create/update policies already force a named first tool. The
        # refine policy uses tool_choice=any, so expose only its two valid
        # terminal alternatives and prevent a read-only route tool from
        # consuming the mandatory call.
        return names & set(required) if len(required) > 1 else names

    def rendered_tools() -> list[dict[str, Any]]:
        names = allowed_tool_names()
        return [render_anthropic_tools([tool])[0] for tool in MAIN_AGENT_TOOLS if tool.name in names]

    execution_policy = execution_policy or TurnExecutionPolicy.chat()

    def required_tool_choice() -> dict[str, str] | None:
        return execution_policy.tool_choice(context.execution_trace)

    initial_names = allowed_tool_names()
    tool_categories = {tool.category for tool in MAIN_AGENT_TOOLS if tool.name in initial_names}
    handlers = TOOL_HANDLERS
    initial_skill = get_skill(context.active_skill_id)
    system = build_system_prompt(
        allow_side_effects=bool(initial_skill and initial_skill.allow_side_effects),
        skill_instructions=load_skill_instructions(initial_skill) if initial_skill else "",
        skill_catalog="" if initial_skill else build_skill_catalog_prompt(),
    )
    # A frozen multi-activity collection is also a resolved target.  Basing
    # this guard solely on current_fit_file incorrectly blocked navigation
    # until the model redundantly resolved one activity again.
    has_resolved = {"value": bool(context.selected_activities)}
    steps_taken: list[dict] = []

    messages = list(context.messages)
    preamble = build_state_preamble(context)
    if preamble:
        messages = [{"role": "user", "content": preamble}] + messages

    hooks = ToolLoopHooks(
        context,
        tool_categories,
        has_resolved,
        steps_taken,
        allowed_tool_names=initial_names,
        allowed_tool_provider=allowed_tool_names,
        terminal_tool_names=(set(execution_policy.completion_tool_names) or None),
        stop_on_failed_tools=(
            set(execution_policy.completion_tool_names)
            if execution_policy.stop_on_required_tool_failure else None
        ),
        verbose=verbose,
    )
    if verbose:
        _log_hdr(message, "chat", len(initial_names), bool(context.current_fit_file), active_skill=initial_skill)

    try:
        # Skill activation is a control-plane round and must not consume one
        # of the business tool-loop steps available to the user request.
        step_count = execute_tool_loop(
            messages, tools=rendered_tools, handlers=handlers, runtime=hooks,
            system=system, max_tokens=max_tokens, max_steps=MAX_TOOL_STEPS + 1,
            client=client, tool_choice=required_tool_choice,
        )
    except LLMRequestError as exc:
        exc.steps_taken = list(steps_taken)
        raise
    finally:
        # LLM 可能在任意一个工具轮次之后断线；保留已完成工具造成的状态，
        # 让交互模式可用“重试”继续，而不是丢失本轮上下文。
        _sync_messages_to_context(context, messages)

    # The activation round belongs to the capability control plane, not the
    # user's business-step budget.  Keep MAX_TOOL_STEPS semantics unchanged.
    business_step_count = step_count - (1 if context.active_skill_id and initial_skill is None else 0)
    return max(0, business_step_count), steps_taken


def _sync_messages_to_context(context, messages):
    """同步长期对话历史,裁剪 tool_use/tool_result 中间态."""
    clean = []
    for m in messages:
        content = m.get("content", "")
        if isinstance(content, str) and content.startswith("[本轮状态]"):
            continue
        if isinstance(content, str) and content.startswith("[结构化活动类型参考]"):
            continue
        if _is_tool_result_message(m):
            continue
        if _has_tool_use_block(m):
            text_blocks = [
                b for b in (content or [])
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text")
            ]
            if text_blocks:
                clean.append({"role": "assistant", "content": text_blocks})
            continue
        clean.append(m)
    context.messages = clean


def _is_tool_result_message(message: dict[str, Any]) -> bool:
    content = message.get("content")
    return (
        message.get("role") == "user"
        and isinstance(content, list)
        and any(isinstance(block, dict) and block.get("type") == "tool_result" for block in content)
    )


def _has_tool_use_block(message: dict[str, Any]) -> bool:
    content = message.get("content")
    return (
        message.get("role") == "assistant"
        and isinstance(content, list)
        and any(isinstance(block, dict) and block.get("type") == "tool_use" for block in content)
    )


def _log_hdr(message, intent, tool_count, has_fit, *, active_skill=None):
    from agent.main_agent.hooks import _log
    _log("─" * 50)
    _log(
        f"skill: \033[1m{active_skill.skill_id if active_skill else 'none'}\033[0m | "
        f"intent: {intent_kind(intent)} | side_effects: {bool(active_skill and active_skill.allow_side_effects)}"
    )
    _log(f"context: fit={'✓' if has_fit else '✗'} | tools: {tool_count}")
    _log(f"message: {message[:100]}")


# Transitional aliases keep evaluation and tests stable while callers migrate
# to prompt_builder directly.
_build_system_prompt = build_system_prompt
_skill_catalog_prompt = build_skill_catalog_prompt
_build_state_preamble = build_state_preamble
