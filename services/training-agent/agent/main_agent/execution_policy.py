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
    stop_on_required_tool_failure: bool = False

    @classmethod
    def chat(cls) -> "TurnExecutionPolicy":
        return cls()

    @classmethod
    def route_plan(cls, action: str) -> "TurnExecutionPolicy":
        tools = {"create": "create_route_plan", "update": "update_route_plan"}
        if action not in tools:
            raise ValueError("route_action must be create or update")
        return cls(
            request_mode="route_plan",
            forced_skill_id="plan-routes",
            required_tool_name=tools[action],
            stop_on_required_tool_failure=True,
        )

    def tool_choice(self, execution_trace: list[dict[str, Any]]) -> dict[str, str] | None:
        if self.required_tool_name and not execution_trace:
            return {"type": "tool", "name": self.required_tool_name}
        return None

    def is_satisfied(self, execution_trace: list[dict[str, Any]]) -> bool:
        if not self.required_tool_name:
            return True
        from agent.main_agent.turn_policy import is_terminal_tool_result

        return any(
            isinstance(item, dict)
            and item.get("tool") == self.required_tool_name
            and is_terminal_tool_result(self.required_tool_name, item.get("result"))
            for item in execution_trace
        )
