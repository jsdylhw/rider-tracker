"""Small builders for DB-backed activity/report tests."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from storage.repositories.activity import ActivityStore


def store_report(root: Path, document: dict[str, Any]) -> dict[str, Any]:
    key = str(document["activity_key"])
    fit = root / f"{key}.fit"
    fit.write_bytes(f"fit-{key}".encode())
    fit_summary = document.get("fit_summary") if isinstance(document.get("fit_summary"), dict) else {}
    metrics = document.get("activity_metrics") if isinstance(document.get("activity_metrics"), dict) else {}
    identity = metrics.get("identity") if isinstance(metrics.get("identity"), dict) else {}
    report = {
        "schema_version": "llm_fit_file_analysis.v2",
        "status": "analyzed",
        "fit_path": str(fit),
        "fit_summary": {
            "sport_type": identity.get("sport_type") or fit_summary.get("sport_type") or "cycling",
            "start_time_local": identity.get("start_time_local") or fit_summary.get("start_time_local"),
            **fit_summary,
        },
        "activity_metrics": {"schema_version": "activity_metrics.v2", **metrics},
        "analysis_summary": {
            "schema_version": "activity_analysis_summary.v1",
            **(document.get("analysis_summary") or {}),
        },
        "markdown_report": document.get("markdown_report") or f"# {key}",
        "strava_summary": document.get("strava_summary") or f"{key} summary",
        **document,
        "activity_key": key,
    }
    store = ActivityStore()
    store.upsert_activity({
        "activity_key": key,
        "fit_path": str(fit),
        "sport_type": report["fit_summary"].get("sport_type") or "cycling",
        "start_time_local": report["fit_summary"].get("start_time_local"),
        "source": "test",
    })
    store.save_report(report)
    return store.get_activity(key) or {}
