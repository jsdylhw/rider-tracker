"""Persistable, deterministic activity features extracted during FIT import.

These are *candidates* and locators, not coaching conclusions.  Keeping them
separate from LLM reports lets normal questions and history comparisons use
stable evidence without reopening a FIT file or parsing report prose.
"""

from __future__ import annotations

from typing import Any

from domain.contracts.schemas import ACTIVITY_FEATURES_V1
from fit.analysis.segments import scan_activity_segments
from fit.analysis.sprints import detect_sprints
from fit.analysis.stats import prune_empty_values


FEATURES_SCHEMA_VERSION = ACTIVITY_FEATURES_V1
FEATURE_EXTRACTOR_VERSION = "fit_features.v1"


def build_activity_features(
    parsed: dict[str, Any],
    *,
    activity_key: str | None = None,
    fit_path: str | None = None,
) -> dict[str, Any]:
    """Extract compact sprint, effort and climb candidates from parsed FIT data.

    The extraction parameters are deliberately fixed for import-time facts.
    A user asking about an exact time/distance window still uses the raw FIT
    tools later; this document only avoids repeatedly rediscovering obvious
    whole-activity features.
    """
    sprint_result = detect_sprints(parsed, max_segments=12)
    scan_result = scan_activity_segments(
        parsed,
        window_seconds=30,
        step_seconds=10,
        max_segments=12,
    )
    segments = _list(scan_result.get("segments"))
    efforts = _list(scan_result.get("efforts"))
    climbs = [segment for segment in segments if segment.get("type") == "climb"]

    return prune_empty_values({
        "schema_version": FEATURES_SCHEMA_VERSION,
        "extractor_version": FEATURE_EXTRACTOR_VERSION,
        "activity_key": activity_key,
        "fit_path": fit_path or parsed.get("path"),
        "sprint_candidates": {
            "available": bool(sprint_result.get("available")),
            "detector": sprint_result.get("detector"),
            "settings": sprint_result.get("settings"),
            "reason": sprint_result.get("reason"),
            "count": int(sprint_result.get("count") or 0),
            "segments": _list(sprint_result.get("segments")),
        },
        "effort_candidates": {
            "available": bool(scan_result.get("available")),
            "settings": scan_result.get("settings"),
            "baselines": scan_result.get("baselines"),
            "summary": scan_result.get("summary"),
            "notes": _list(scan_result.get("notes")),
            "efforts": efforts,
        },
        "climb_candidates": {
            "available": bool(scan_result.get("available")),
            "count": len(climbs),
            "segments": climbs,
        },
    })


def _list(value: Any) -> list[dict[str, Any]]:
    """Keep only JSON-object feature records from detector output."""
    return [dict(item) for item in value if isinstance(item, dict)] if isinstance(value, list) else []
