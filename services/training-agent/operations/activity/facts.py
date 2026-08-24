"""Maintenance operation for deterministic FIT facts.

Import paths write facts automatically.  This operation backfills activities
that existed before ``activity_facts`` was introduced, without generating or
rewriting LLM reports.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fit.parser import parse_fit
from services.activity.catalog import persist_activity_facts
from storage.repositories.activity import ActivityStore


def rebuild_activity_facts(*, force: bool = False, path: str | Path | None = None) -> dict[str, Any]:
    """Backfill deterministic metrics/features for every indexed FIT activity."""
    store = ActivityStore(path)
    rebuilt: list[str] = []
    skipped: list[str] = []
    failed: list[dict[str, str]] = []
    for activity in store.list_activity_entries():
        activity_key = str(activity.get("activity_key") or "")
        fit_path = str(activity.get("fit_path") or "")
        if not activity_key or not fit_path:
            continue
        if not force and store.get_facts(activity_key) is not None:
            skipped.append(activity_key)
            continue
        try:
            parsed = parse_fit(fit_path)
            persist_activity_facts(
                parsed,
                activity_key=activity_key,
                fit_path=fit_path,
                path=path,
            )
        except Exception as exc:
            failed.append({
                "activity_key": activity_key,
                "fit_path": fit_path,
                "error": type(exc).__name__,
                "message": str(exc),
            })
        else:
            rebuilt.append(activity_key)
    return {
        "schema_version": "activity_facts_rebuild.v1",
        "status": "partial" if failed else "completed",
        "rebuilt": len(rebuilt),
        "skipped": len(skipped),
        "failed": len(failed),
        "failed_items": failed,
    }
