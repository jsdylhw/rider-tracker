"""Context-free access to persisted activity report documents."""

from __future__ import annotations

from typing import Any

from storage.repositories.activity import ActivityStore


def read_activity_report(activity: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """Read the current SQLite report for an explicit activity."""
    activity_key = str(activity.get("activity_key") or "")
    if not activity_key:
        return None, "missing_activity_key"
    stored = ActivityStore().get_report_for_activity(activity)
    return (stored, None) if stored else (None, "missing_activity_report")
