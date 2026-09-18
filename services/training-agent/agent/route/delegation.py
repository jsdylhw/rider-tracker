"""Adapt Main Agent delegation to the same route task used by the route page."""
from copy import deepcopy
from uuid import uuid4

from agent.route.agent import run_route_agent
from agent.route.contracts import RouteTaskInput
from agent.runtime.models import public_turn_dict


def delegate_route_task(args, context):
    action = args.get("action", "refine")
    reference = context.route_reference or {}
    if action == "create":
        reference = {}
    message = next((item["content"] for item in reversed(context.messages)
                    if item.get("role") == "user" and isinstance(item.get("content"), str)),
                   str(args.get("message") or "")).strip()
    if not message:
        raise ValueError("路线需求不能为空")
    task = RouteTaskInput(
        message=message, action=action,
        workspace_id=str(context.workspace_id or context.session_id),
        request_id=context.request_id or f"route-{uuid4().hex}",
        plan_id=reference.get("plan_id"), revision=reference.get("revision"),
        options={"include_elevation": False, **context.route_request_options},
    )
    if action == "create":
        context.route_reference = None
        context.route_messages = []
    result, dialogue = run_route_agent(
        task, history=[] if action == "create" else deepcopy(context.route_messages),
    )
    context.route_messages = dialogue
    if action == "create" or result.get("route_task", {}).get("action") == "create":
        context.route_reference = None
    if result.get("route_task", {}).get("status") == "completed":
        plan = result["route_plan"]
        context.route_reference = {"plan_id": plan["plan_id"], "revision": plan["revision"]}
    # Parent trace records this delegation, child trace remains inside its result.
    # Never expose the child's mutable Context to the parent tool loop.
    return public_turn_dict(result)
