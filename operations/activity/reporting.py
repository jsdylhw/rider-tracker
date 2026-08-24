"""单 FIT 数据库报告生成操作适配器。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from operations.activity.service import analyze_fit_file_tool
from storage.repositories.activity import ActivityStore


def ensure_summary(fit_path: str | Path, *, force: bool = False) -> dict[str, Any]:
    """确保一个 FIT 在 SQLite 中有一份当前 V2 报告。"""
    path = Path(fit_path).expanduser()
    if not path.exists():
        return _failed(path, "fit_not_found", f"FIT file does not exist: {path}")
    if path.suffix.lower() != ".fit":
        return _failed(path, "invalid_fit_path", f"Expected a .fit file: {path}")
    try:
        result = analyze_fit_file_tool(str(path), force=force)
    except Exception as exc:
        return _failed(path, type(exc).__name__, str(exc))

    activity_key = str(result.get("activity_key") or "")
    report_persisted = bool(activity_key and ActivityStore().get_report(activity_key))
    if result.get("error") or not report_persisted:
        return _failed(
            path,
            str(result.get("error") or "report_not_persisted"),
            str(result.get("message") or "Analysis did not persist an activity report"),
            raw_result=result,
        )
    status = "skipped" if result.get("status") == "skipped_existing_summary" else "completed"
    return {
        "schema_version": "activity_operation_analysis.v1",
        "operation": "ensure_summary",
        "status": status,
        "activity_key": result.get("activity_key"),
        "fit_path": str(path),
        "report_schema_version": "llm_fit_file_analysis.v2",
        "result_status": result.get("status"),
        "raw_result": result,
    }


def _failed(path: Path, error: str, message: str, *, raw_result: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema_version": "activity_operation_analysis.v1",
        "operation": "ensure_summary",
        "status": "failed",
        "fit_path": str(path),
        "error": error,
        "message": message,
    }
    if raw_result is not None:
        result["raw_result"] = raw_result
    return result
