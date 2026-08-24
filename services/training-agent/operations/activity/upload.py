"""Strava 上传操作适配器。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from operations.activity.service import upload_to_strava_tool


def upload_activity(fit_path: str | Path, *, force: bool = False) -> dict[str, Any]:
    """上传一个已分析 FIT。"""
    path = Path(fit_path).expanduser()
    if not path.exists():
        return _failed(path, "fit_not_found", f"FIT file does not exist: {path}")
    try:
        result = upload_to_strava_tool(str(path), force=force)
    except Exception as exc:
        return _failed(path, type(exc).__name__, str(exc))

    if result.get("error"):
        return _failed(path, str(result.get("error")), str(result.get("message") or "Strava upload failed"), raw_result=result)
    outcome = str(result.get("status") or "")
    if outcome not in {"uploaded", "duplicate", "description_updated"}:
        return _failed(path, "upload_not_completed", str(result.get("message") or outcome or "Upload was not executed"), raw_result=result)
    return {
        "schema_version": "activity_operation_strava_upload.v1",
        "operation": "upload_activity",
        "status": "completed",
        "outcome": outcome,
        "fit_path": str(path),
        "strava_activity_id": result.get("strava_activity_id"),
        "raw_result": result,
    }


def _failed(path: Path, error: str, message: str, *, raw_result: dict[str, Any] | None = None) -> dict[str, Any]:
    response: dict[str, Any] = {
        "schema_version": "activity_operation_strava_upload.v1",
        "operation": "upload_activity",
        "status": "failed",
        "fit_path": str(path),
        "error": error,
        "message": message,
    }
    if raw_result is not None:
        response["raw_result"] = raw_result
    return response
