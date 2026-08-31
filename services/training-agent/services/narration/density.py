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


def narration_research_policy(duration_minutes: Any) -> dict[str, int]:
    """Bound provider work independently from the desired card count.

    A narration card is a presentation unit, not a Google Places request. Most
    cards describe the route region, landscape, history or local culture and
    may reuse a small set of read sources. Only a minority describe a precise
    point of interest and therefore need a source tied to that route sample.
    """
    density = narration_density(duration_minutes)
    target = density["target"]
    return {
        "place_card_maximum": max(3, min(8, round(target / 3))),
        "search_request_maximum": max(8, min(18, round(target * 0.75))),
        "samples_per_search": 3,
        "search_concurrency": 4,
    }
