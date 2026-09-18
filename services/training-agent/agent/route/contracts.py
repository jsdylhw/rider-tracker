"""Versioned route task boundary; workspace ownership comes from the server."""
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class RouteTaskInput:
    schema_version = "route_task_input.v1"
    message: str
    workspace_id: str
    request_id: str
    action: str = "create"
    plan_id: str | None = None
    revision: int | None = None
    options: dict[str, Any] = field(default_factory=lambda: {"include_elevation": False})

    def __post_init__(self):
        if self.action not in {"create", "update", "refine"}:
            raise ValueError("invalid route action")
        if self.plan_id is not None and (not isinstance(self.plan_id, str) or not self.plan_id.strip() or len(self.plan_id) > 128):
            raise ValueError("invalid plan_id")
        if bool(self.plan_id) != (self.revision is not None):
            raise ValueError("plan_id and revision must be supplied together")
        if self.revision is not None and (type(self.revision) is not int or self.revision < 1):
            raise ValueError("revision must be a positive integer")
        if self.action == "update" and not self.plan_id:
            raise ValueError("update requires a plan reference")


def project_task_result(result: dict[str, Any], task: RouteTaskInput) -> dict[str, Any]:
    if result.get("status") == "completed" and not result.get("route_plan"):
        result.update(status="failed", answer="路线工具没有返回可展示的计划，请重试。", error={
            "code": "route_result_missing", "stage": "route_projection", "retryable": False,
            "message": "路线工具没有返回可展示的计划，请重试。",
        })
    # The public trace layout can evolve; action is derived only from this
    # turn's executed tool facts, never model prose or the old draft.
    actual = result.pop("_route_action", None)
    action_executed = result.pop("_route_action_executed", False)
    result["route_task"] = {
        "schema_version": "route_task.v1", "request_id": task.request_id,
        "status": "completed" if result.get("route_plan") and not result.get("error") else (
            "clarification_required" if result.get("status") == "clarification_required" else "failed"
        ),
        "action": actual, "action_executed": action_executed,
        "plan_id": (result.get("route_plan") or {}).get("plan_id"),
        "revision": (result.get("route_plan") or {}).get("revision"),
    }
    return result
