"""Main-agent control tools that do not invoke domain services."""

from __future__ import annotations

from typing import Any

from agent.main_agent.context import AgentContext
from agent.main_agent.turn_policy import activation_note
from agent.skills import get_skill, load_skill_instructions


def activate_skill(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    skill_id = str(args.get("skill_id") or "").strip()
    skill = get_skill(skill_id)
    if skill is None:
        return {
            "status": "failed",
            "error": "unknown_skill",
            "message": f"Unknown skill: {skill_id}",
        }
    context.active_skill_id = skill.skill_id
    context.last_used_skills = [skill.skill_id]
    context.conversation_used_skills.append(skill.skill_id)
    context.active_skill_confidence = 1.0
    context.active_skill_reason = "activated_by_main_agent"
    latest_message = next((
        str(item.get("content") or "") for item in reversed(context.messages)
        if isinstance(item, dict) and item.get("role") == "user"
    ), "")
    instructions = load_skill_instructions(skill)
    note = activation_note(skill.skill_id, latest_message)
    if note:
        instructions = f"{instructions}\n\n{note}"
    return {
        "status": "activated",
        "skill_id": skill.skill_id,
        "instructions": instructions,
        "allowed_tools": list(skill.tool_names),
        "allow_side_effects": skill.allow_side_effects,
    }


def casual_chat(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return {"answer": args.get("answer") or args.get("message") or "你好，我在。"}


def ask_user_clarification(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return {"answer": args.get("question") or "请再描述一下你的需求。"}


HANDLERS = {
    "activate_skill": activate_skill,
    "casual_chat": casual_chat,
    "ask_user_clarification": ask_user_clarification,
}
