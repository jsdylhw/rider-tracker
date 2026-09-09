"""Duration-aware narration density policy."""

from __future__ import annotations

import math
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
        # Short routes previously collapsed to four cards because target - 4
        # is disproportionately permissive at the low end. Keep at least 75%
        # of the duration-derived target while retaining the existing
        # two-hour range (20-32 cards around a target of 24).
        "minimum": max(4, target - 4, math.ceil(target * 0.75)),
        "target": target,
        "maximum": min(44, target + 8),
    }


def narration_research_policy(duration_minutes: Any) -> dict[str, int]:
    """Choose a small set of route anchors independently from card count.

    One Google Places request is made for each representative anchor.  The
    resulting place bundle is then sent to the model once; narration cards do
    not fan out into their own provider requests.
    """
    density = narration_density(duration_minutes)
    target = density["target"]
    return {
        "place_card_maximum": max(3, min(8, round(target / 3))),
        "anchor_count": max(4, min(8, round(target / 4))),
        "places_per_anchor": 4,
        "search_concurrency": 8,
    }
