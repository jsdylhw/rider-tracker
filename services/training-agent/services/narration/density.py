"""Duration-aware narration density policy."""

from __future__ import annotations

from typing import Any


def narration_density(duration_minutes: Any) -> dict[str, int]:
    """Return a useful range, not a hard output count.

    Standard density is roughly one card per five minutes. Sparse source
    material may produce fewer cards; the agent must never invent filler.
    """
    try:
        duration = max(1.0, float(duration_minutes))
    except (TypeError, ValueError):
        duration = 60.0
    target = max(6, min(36, round(duration / 5)))
    return {
        "minimum": max(4, target - 4),
        "target": target,
        "maximum": min(44, target + 8),
    }
