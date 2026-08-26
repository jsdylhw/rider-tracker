"""Strava 上传操作适配器。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from operations.activity.service import upload_to_strava_tool
from project_paths import resolve_project_path


def upload_activity(
    fit_path: str | Path,
    *,
    force: bool = False,
    pending_upload_id: int | str | None = None,
) -> dict[str, Any]:
    """上传一个已分析 FIT。"""
    path = resolve_project_path(fit_path)
    if not path.exists():
        return _failed(path, "fit_not_found", f"FIT file does not exist: {path}")
    try:
        kwargs: dict[str, Any] = {"force": force}
        if pending_upload_id is not None:
            kwargs["pending_upload_id"] = pending_upload_id
        result = upload_to_strava_tool(str(path), **kwargs)
    except Exception as exc:
        return _failed(path, type(exc).__name__, str(exc))

    if result.get("error"):
        failed = _failed(
            path,
            str(result.get("error")),
            str(result.get("message") or "Strava upload failed"),
            raw_result=result,
        )
        if result.get("pending_upload_id") is not None:
            failed["pending_upload_id"] = result.get("pending_upload_id")
        return failed
    outcome = str(result.get("status") or "")
    if outcome not in {"uploaded", "duplicate", "description_updated"}:
        return _failed(path, "upload_not_completed", str(result.get("message") or outcome or "Upload was not executed"), raw_result=result)
    return {
        "operation": "upload_activity",
        "status": "completed",
        "outcome": outcome,
        "fit_path": str(path),
        "strava_activity_id": result.get("strava_activity_id"),
        "raw_result": result,
    }


def _failed(path: Path, error: str, message: str, *, raw_result: dict[str, Any] | None = None) -> dict[str, Any]:
    response: dict[str, Any] = {
        "operation": "upload_activity",
        "status": "failed",
        "fit_path": str(path),
        "error": error,
        "message": message,
    }
    if raw_result is not None:
        response["raw_result"] = raw_result
    return response
