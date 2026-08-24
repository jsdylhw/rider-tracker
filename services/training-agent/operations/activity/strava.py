"""Publish one SQLite-backed activity report through the Strava adapter."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from storage.repositories.activity import ActivityStore
from integrations.strava import StravaSink


def upload_activity_to_strava(
    activity_key: str,
    *,
    title: str | None = None,
    wait: bool = True,
    force: bool = False,
) -> dict[str, Any]:
    """Upload the FIT referenced by one persisted V2 report."""
    store = ActivityStore()
    activity = store.get_activity(activity_key)
    report = store.get_report(activity_key)
    if activity is None:
        raise KeyError(f"activity not found: {activity_key}")
    if report is None:
        raise KeyError(f"activity report not found: {activity_key}")

    fit_path = str(activity.get("fit_path") or report.get("fit_path") or "")
    if not fit_path or not Path(fit_path).exists():
        raise FileNotFoundError(fit_path or f"FIT path missing for {activity_key}")
    description = str(report.get("strava_summary") or "").strip()
    if not description:
        raise RuntimeError("activity report does not contain strava_summary")

    fit_summary = report.get("fit_summary") if isinstance(report.get("fit_summary"), dict) else {}
    upload_title = title or _default_title(fit_summary, Path(fit_path))
    sink = StravaSink()
    known_activity_id = _known_strava_activity_id(activity, report)
    if force and known_activity_id:
        updated = sink.update_description(known_activity_id, description)
        _remember_strava_activity_id(store, activity, report, known_activity_id)
        return {
            "activity_key": activity_key,
            "fit_path": fit_path,
            "status": "description_updated",
            "strava_activity_id": known_activity_id,
            "update_result": updated,
            "message": f"已更新 Strava 活动 {known_activity_id} 的描述。",
        }

    upload = sink.upload_fit(
        fit_path,
        title=upload_title,
        description=description,
        external_id=activity_key,
    )
    result: dict[str, Any] = {
        "activity_key": activity_key,
        "fit_path": fit_path,
        "title": upload_title,
        "description": description,
        "upload": upload,
    }
    upload_id = upload.get("id")
    if wait and upload_id is not None:
        result["upload_status"] = sink.wait_for_upload(upload_id)
    elif not wait and upload_id is None:
        result["upload_status"] = upload

    duplicate_id = _parse_duplicate_activity_id(result.get("upload_status") or {})
    if duplicate_id:
        _remember_strava_activity_id(store, activity, report, duplicate_id)
        if force:
            result.update({
                "status": "description_updated",
                "strava_activity_id": duplicate_id,
                "update_result": sink.update_description(duplicate_id, description),
            })
            result.pop("upload_status", None)
        else:
            return {
                "activity_key": activity_key,
                "fit_path": fit_path,
                "status": "duplicate",
                "strava_activity_id": duplicate_id,
                "message": (
                    f"该活动已上传到 Strava (activity_id={duplicate_id})。"
                    "使用 --force 更新描述。"
                ),
            }

    uploaded_activity_id = (result.get("upload_status") or {}).get("activity_id")
    if uploaded_activity_id:
        _remember_strava_activity_id(store, activity, report, str(uploaded_activity_id))
    return result


def update_strava_description(activity_id: str, activity_key: str) -> dict[str, Any]:
    """Update a Strava description from the current SQLite report."""
    store = ActivityStore()
    activity = store.get_activity(activity_key)
    report = store.get_report(activity_key)
    if activity is None or report is None:
        raise KeyError(f"activity report not found: {activity_key}")
    description = str(report.get("strava_summary") or "").strip()
    if not description:
        raise RuntimeError("activity report does not contain strava_summary")
    result = StravaSink().update_description(activity_id, description)
    _remember_strava_activity_id(store, activity, report, str(activity_id))
    return result


def _known_strava_activity_id(activity: dict[str, Any], report: dict[str, Any]) -> str | None:
    value = activity.get("strava_activity_id") or report.get("strava_activity_id")
    return str(value) if value else None


def _remember_strava_activity_id(
    store: ActivityStore,
    activity: dict[str, Any],
    report: dict[str, Any],
    activity_id: str,
) -> None:
    """Commit remote identity to both normalized and report records."""
    if not activity_id:
        return
    updated_report = {**report, "strava_activity_id": str(activity_id)}
    store.save_report(updated_report)
    store.upsert_activity({**activity, "strava_activity_id": str(activity_id)})


def _parse_duplicate_activity_id(status: dict[str, Any]) -> str | None:
    error = status.get("error")
    if not isinstance(error, str):
        return None
    match = re.search(r"/activities/(\d+)", error)
    return match.group(1) if match else None


def _default_title(fit_summary: dict[str, Any], fit_path: Path) -> str:
    start_time = str(fit_summary.get("start_time_local") or fit_summary.get("start_time") or "")[:10]
    sport = fit_summary.get("sport_type") or "activity"
    return f"{start_time} {sport}" if start_time else fit_path.stem
