"""Load a selected skill body and deterministic sport references."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

from agent.skills.models import SkillSpec

SKILL_LIBRARY = Path(__file__).with_name("library")


def _skill_path(skill: SkillSpec) -> Path:
    """Resolve a trusted catalogue entry as either a Markdown file or package."""
    path = SKILL_LIBRARY / (skill.library_path or skill.skill_id)
    return path if path.suffix == ".md" else path / "SKILL.md"


def _reference_directory(skill: SkillSpec) -> Path:
    """Keep optional references grouped by Skill inside its category."""
    path = SKILL_LIBRARY / (skill.library_path or skill.skill_id)
    return path.parent / "references" / skill.skill_id if path.suffix == ".md" else path / "references"


def load_skill_instructions(skill: SkillSpec, *, sport_types: Iterable[str] = ()) -> str:
    """Load SKILL.md only after activation, then add bounded references."""
    body = _markdown_body(_skill_path(skill).read_text(encoding="utf-8"))
    references = list(load_skill_references(skill, sport_types=sport_types))
    return "\n\n".join(part for part in (body.strip(), *references) if part)


def load_skill_references(skill: SkillSpec, *, sport_types: Iterable[str] = ()) -> tuple[str, ...]:
    """Load only references explicitly registered for the activated Skill."""
    names = [*_general_reference_names(skill), *_sport_reference_names(sport_types)]
    references: list[str] = []
    for reference_name in names:
        path = _reference_directory(skill) / f"{reference_name}.md"
        if path.exists():
            references.append(path.read_text(encoding="utf-8").strip())
    return tuple(references)


def load_sport_references(skill: SkillSpec, *, sport_types: Iterable[str]) -> tuple[str, ...]:
    """Load only references selected by structured sport values."""
    if skill.skill_id != "analyze-activity":
        return ()
    return load_skill_references(skill, sport_types=sport_types)


def _general_reference_names(skill: SkillSpec) -> tuple[str, ...]:
    if skill.skill_id == "analyze-training-history":
        return ("methodology", "output-contract")
    return ()


def _markdown_body(text: str) -> str:
    """Remove frontmatter because its metadata was already used in stage one."""
    if text.startswith("---"):
        match = re.match(r"^---\s*\n.*?\n---\s*\n", text, flags=re.DOTALL)
        if match:
            return text[match.end():]
    return text


def _sport_reference_names(sport_types: Iterable[str]) -> tuple[str, ...]:
    """Map trusted activity records to reference files without LLM guessing."""
    names: list[str] = []
    for raw in sport_types:
        value = str(raw or "").lower()
        name = None
        if any(token in value for token in ("run", "跑")):
            name = "running"
        elif any(token in value for token in ("ride", "cycl", "bike", "骑")):
            name = "cycling"
        elif any(token in value for token in ("walk", "hike", "徒步", "步行")):
            name = "walking"
        if name and name not in names:
            names.append(name)
    return tuple(names)
