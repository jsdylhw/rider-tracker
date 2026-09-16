"""Immutable requirements attached to one Agent turn by a trusted entrypoint."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


ROUTE_RESULT_TOOLS = frozenset({
    "create_route_plan", "create_itinerary_plan", "update_route_plan",
    "get_route_plan", "explore_route_segments",
})


@dataclass(frozen=True)
class TurnExecutionPolicy:
    """Describe authority and completion without inferring it from Agent state."""

    request_mode: str = "chat"
    forced_skill_id: str | None = None
    required_tool_name: str | None = None
    required_tool_names: frozenset[str] = frozenset()
    stop_on_required_tool_failure: bool = False

    @classmethod
    def chat(cls) -> "TurnExecutionPolicy":
        return cls()

    @classmethod
    def route_plan(cls, action: str) -> "TurnExecutionPolicy":
        tools = {"create": "create_route_plan", "update": "update_route_plan"}
        if action == "refine":
            required = frozenset(tools.values())
            return cls(
                request_mode="route_plan",
                forced_skill_id="plan-routes",
                required_tool_names=required,
                stop_on_required_tool_failure=True,
            )
        if action not in tools:
            raise ValueError("route_action must be create, update or refine")
        required_tool = tools[action]
        return cls(
            request_mode="route_plan",
            forced_skill_id="plan-routes",
            required_tool_name=required_tool,
            required_tool_names=frozenset({required_tool}),
            stop_on_required_tool_failure=True,
        )

    @property
    def completion_tool_names(self) -> frozenset[str]:
        if self.required_tool_names:
            return self.required_tool_names
        return frozenset({self.required_tool_name}) if self.required_tool_name else frozenset()

    def accepts_tool(self, tool_name: str) -> bool:
        required = self.completion_tool_names
        return not required or tool_name in required

    def tool_choice(self, execution_trace: list[dict[str, Any]]) -> dict[str, str] | None:
        required = self.completion_tool_names
        if required and not execution_trace:
            if len(required) == 1:
                return {"type": "tool", "name": next(iter(required))}
            return {"type": "any"}
        return None

    def is_satisfied(self, execution_trace: list[dict[str, Any]]) -> bool:
        required = self.completion_tool_names
        if not required:
            return True
        from agent.main_agent.turn_policy import is_terminal_tool_result

        return any(
            isinstance(item, dict)
            and item.get("tool") in required
            and is_terminal_tool_result(str(item.get("tool") or ""), item.get("result"))
            for item in execution_trace
        )
