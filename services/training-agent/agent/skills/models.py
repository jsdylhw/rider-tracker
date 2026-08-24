"""Immutable models shared by the Skill catalogue, loader, and guards."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SkillSpec:
    """One domain protocol and the exact main-agent tools it may expose."""

    skill_id: str
    description: str
    tool_names: tuple[str, ...]
    public_intent: str
    allow_side_effects: bool = False
    library_path: str | None = None

    def public_descriptor(self) -> dict[str, str]:
        """Return metadata safe to include before Skill activation."""
        return {"skill_id": self.skill_id, "description": self.description}
