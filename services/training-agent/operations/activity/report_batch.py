"""In-process background jobs for bulk V2 report regeneration.

These jobs are intentionally not durable.  Activity/report truth is durable in
SQLite, while a lost process merely leaves some activities on the old report
version; the same idempotent request can be submitted again.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from threading import Lock
from typing import Any
from uuid import uuid4

from domain.analysis.artifacts import SUMMARY_SCHEMA_V2
from storage.repositories.activity import ActivityStore


_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="activity-report")
_LOCK = Lock()
_JOBS: dict[str, dict[str, Any]] = {}


def submit_activity_report_rebuild(
    *,
    scope: str = "all",
    activity_keys: list[str] | None = None,
) -> dict[str, Any]:
    """Queue all activities, or only activities without a current V2 report."""
    if scope not in {"all", "outdated"}:
        raise ValueError("scope must be all or outdated")

    activities = ActivityStore().list_activity_entries()
    requested_keys = {str(value) for value in activity_keys or [] if value}
    if requested_keys:
        activities = [activity for activity in activities if str(activity.get("activity_key")) in requested_keys]
    if scope == "outdated":
        activities = [
            activity
            for activity in activities
            if activity.get("summary_schema_version") != SUMMARY_SCHEMA_V2
        ]

    signature = f"v2:{scope}:{','.join(sorted(requested_keys))}"
    with _LOCK:
        # Duplicate chat requests should observe the active job instead of
        # launching a second set of expensive LLM calls.
        for job in _JOBS.values():
            if job.get("signature") == signature and job.get("status") in {"queued", "running"}:
                return _public_job(job, reused=True)

        job_id = uuid4().hex
        now = _now()
        job = {
            "kind": "activity_report_job",
            "job_id": job_id,
            "signature": signature,
            "scope": scope,
            "status": "queued" if activities else "completed",
            "created_at": now,
            "started_at": None,
            "finished_at": now if not activities else None,
            "total": len(activities),
            "completed": 0,
            "failed": 0,
            "activities": [
                {
                    "activity_key": activity.get("activity_key"),
                    "fit_path": activity.get("fit_path"),
                    "previous_schema_version": activity.get("summary_schema_version"),
                    "status": "pending",
                }
                for activity in activities
            ],
        }
        _JOBS[job_id] = job

    if activities:
        _EXECUTOR.submit(_run_job, job_id)
    return _public_job(job)


def get_activity_report_job(job_id: str) -> dict[str, Any]:
    """Return a consistent snapshot without exposing mutable worker state."""
    with _LOCK:
        job = _JOBS.get(str(job_id))
        if job is None:
            return {
                "kind": "activity_report_job",
                "status": "not_found",
                "job_id": str(job_id),
            }
        return _public_job(job)


def _run_job(job_id: str) -> None:
    # Import lazily so starting the chat process does not initialize the LLM
    # analysis stack until a rebuild is actually requested.
    from agent.analysis.agent import analyze_fit_file

    with _LOCK:
        job = _JOBS[job_id]
        job["status"] = "running"
        job["started_at"] = _now()

    for index in range(len(job["activities"])):
        with _LOCK:
            item = job["activities"][index]
            item["status"] = "running"
            fit_path = str(item.get("fit_path") or "")
        try:
            result = analyze_fit_file(
                fit_path,
                force=True,
                persist=True,
                use_history=False,
            )
            stored = ActivityStore().get_report(str(item.get("activity_key") or ""))
            if not stored or stored.get("schema_version") != SUMMARY_SCHEMA_V2:
                raise RuntimeError("V2 report was not committed to activity_reports")
        except Exception as exc:
            with _LOCK:
                item["status"] = "failed"
                item["error"] = type(exc).__name__
                item["message"] = str(exc)
                job["failed"] += 1
        else:
            with _LOCK:
                item["status"] = "completed"
                item["schema_version"] = result.get("schema_version")
                job["completed"] += 1

    with _LOCK:
        job = _JOBS[job_id]
        job["status"] = "partial" if job["failed"] else "completed"
        job["finished_at"] = _now()


def _public_job(job: dict[str, Any], *, reused: bool = False) -> dict[str, Any]:
    result = deepcopy({key: value for key, value in job.items() if key != "signature"})
    result["reused"] = reused
    return result


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
