"""Guard, trace, and dynamic-reference middleware for the tool loop."""

from __future__ import annotations

from typing import Any

from agent.main_agent.tool_result import is_failed_tool_output
from agent.main_agent.turn_policy import is_terminal_tool_result
from agent.runtime.models import ToolExecution
from agent.tools.display import format_tool_args, summarize_tool_output, tool_label


class ToolLoopHooks:
    """Apply the fixed middleware order around each model-requested tool."""

    def __init__(self, context, allowed_cats, has_resolved_ref, steps_taken, *,
                 allowed_tool_names=None, allowed_tool_provider=None, verbose=False):
        self.context = context
        self.allowed_cats = allowed_cats
        self.has_resolved_ref = has_resolved_ref
        self.steps_taken = steps_taken
        self.allowed_tool_names = set(allowed_tool_names) if allowed_tool_names is not None else None
        self.allowed_tool_provider = allowed_tool_provider
        self.verbose = verbose
        self.final_response_only = False
        self.terminal_answer: str | None = None
        self._tool_call_count = 0
        self._tool_call_indices: dict[str, int] = {}
        self._navigation_before: dict[str, dict[str, Any]] = {}

    def before_llm_call(self) -> dict[str, str] | None:
        reference = getattr(self.context, "pending_skill_reference", None)
        if reference:
            self.context.pending_skill_reference = None
            return {"role": "user", "content": reference}
        return None

    def on_tool_round(self) -> None:
        return None

    def on_error(self, block: dict[str, Any], error: Exception) -> dict[str, Any] | None:
        return None

    def on_loop_end(self, *, messages: list[dict[str, Any]], response: dict[str, Any], steps: int) -> None:
        return None

    def pre_tool_use(self, block: dict[str, Any], *, step_count: int) -> dict[str, Any] | None:
        self._tool_call_count += 1
        call_id = str(block.get("id") or self._tool_call_count)
        self._tool_call_indices[call_id] = self._tool_call_count
        self._navigation_before[call_id] = _navigation_summary(self.context)
        if self.verbose:
            self._log_pre_tool(block, tool_index=self._tool_call_count)
        return self._guard_tool_call(block)

    def post_tool_use(self, block: dict[str, Any], output: Any, *, step_count: int) -> None:
        name = str(block.get("name") or "")
        call_id = str(block.get("id") or "")
        tool_index = self._tool_call_indices.get(call_id, self._tool_call_count)
        if name == "activate_skill":
            # Activation changes next-round capabilities but is not a
            # user-visible business execution.
            if not is_failed_tool_output(output) and self.allowed_tool_provider is not None:
                self.allowed_tool_names = set(self.allowed_tool_provider())
                from agent.tools.agent_tools import MAIN_AGENT_TOOLS
                self.allowed_cats = {
                    tool.category for tool in MAIN_AGENT_TOOLS
                    if tool.name in self.allowed_tool_names
                }
            if self.verbose:
                self._log_post_tool(block, output, tool_index=tool_index)
            return

        self.context.last_tool_result = {"step_name": name, "result": output}
        self.steps_taken.append({"tool": name, "input": block.get("input", {})})
        payload = output if isinstance(output, dict) else {"result": output}
        self.context.execution_trace.append(ToolExecution(
            index=tool_index - 1,
            tool=name,
            input=block.get("input", {}),
            status=str(payload.get("status") or ("failed" if is_failed_tool_output(output) else "completed")),
            message=str(payload["message"]) if payload.get("message") is not None else None,
            error=str(payload["error"]) if payload.get("error") is not None else None,
            result=output,
            navigation_before=self._navigation_before.get(call_id),
            navigation_after=_navigation_summary(self.context),
        ).to_dict())
        if is_failed_tool_output(output):
            self.context.last_failed_action = {"tool": name, "input": block.get("input", {}) or {}}
        elif name == (self.context.last_failed_action or {}).get("tool"):
            self.context.last_failed_action = None
        if name == "resolve_activities":
            self.has_resolved_ref["value"] = True
            if self.context.active_skill_id == "analyze-activity":
                self._append_activity_sport_reference()
        if is_terminal_tool_result(name, output):
            self.final_response_only = True
            if isinstance(output, dict):
                answer = str(output.get("answer") or "").strip()
                if answer:
                    self.terminal_answer = answer
        if self.verbose:
            self._log_post_tool(block, output, tool_index=tool_index)

    def _append_activity_sport_reference(self) -> None:
        """Load sport guidance only after trusted activity resolution."""
        from agent.skills import get_skill, load_sport_references

        skill = get_skill(self.context.active_skill_id)
        if skill is None:
            return
        sport_types = [
            str(activity.get("sport_type") or "")
            for activity in self.context.selected_activities
            if isinstance(activity, dict)
        ]
        sections = load_sport_references(skill, sport_types=sport_types)
        if sections:
            self.context.pending_skill_reference = "[结构化活动类型参考]\n" + "\n\n".join(sections)

    def _guard_tool_call(self, block: dict[str, Any]) -> dict[str, Any] | None:
        from agent.main_agent.guard import guard_tool_call

        guard = guard_tool_call(
            block.get("name", ""), block.get("input", {}), context=self.context,
            allowed_categories=self.allowed_cats,
            allowed_tool_names=self.allowed_tool_names,
            has_resolved=self.has_resolved_ref["value"],
        )
        return None if guard.allowed else {"error": "guarded", "reason": guard.reason}

    @staticmethod
    def _log_pre_tool(block: dict[str, Any], *, tool_index: int) -> None:
        name = str(block.get("name") or "")
        _log(f"  [#{tool_index}] \033[33m→\033[0m \033[1m{tool_label(name)}\033[0m [{name}]：{format_tool_args(block)}")

    @staticmethod
    def _log_post_tool(block: dict[str, Any], output: Any, *, tool_index: int) -> None:
        _log(f"  [#{tool_index}] \033[32m←\033[0m {summarize_tool_output(str(block.get('name') or ''), output)}")


def _navigation_summary(context: Any) -> dict[str, Any]:
    """Return compact navigation facts suitable for logs, never full ID sets."""
    navigation = getattr(context, "analysis_navigation", None)
    if not isinstance(navigation, dict):
        return {"root_type": None, "root_count": 0, "focus_type": None}
    root = navigation.get("root_scope") if isinstance(navigation.get("root_scope"), dict) else {}
    stack = navigation.get("focus_stack") if isinstance(navigation.get("focus_stack"), list) else []
    focus = stack[-1] if stack and isinstance(stack[-1], dict) else {}
    return {
        "root_type": root.get("type"),
        "root_count": len(root.get("ids") or ([root.get("id")] if root.get("id") else [])),
        "focus_type": focus.get("type"), "focus_id": focus.get("id"), "depth": len(stack),
    }


def _log(msg: str) -> None:
    import sys
    print(f"\033[2m[agent]\033[0m {msg}", file=sys.stderr, flush=True)


# Compatibility exports for existing tests and small external integrations.
_format_tool_args = format_tool_args
_summarize_output = summarize_tool_output
_tool_label = tool_label
_is_terminal_analysis_result = is_terminal_tool_result
