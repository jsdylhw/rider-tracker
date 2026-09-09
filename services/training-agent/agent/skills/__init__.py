"""Project-local skill control plane for progressive tool disclosure."""

from agent.skills.catalog import SKILL_CATALOG, get_skill, list_skill_descriptors, skill_allows_tool
from agent.skills.loader import load_skill_instructions, load_sport_references
from agent.skills.models import SkillSpec

__all__ = [
    "SKILL_CATALOG",
    "SkillSpec",
    "get_skill",
    "list_skill_descriptors",
    "load_skill_instructions",
    "load_sport_references",
    "skill_allows_tool",
]
