"""Garmin 同步操作适配器。"""

from __future__ import annotations

from typing import Any

from operations.activity.service import sync_garmin_activities_tool


def sync_recent(*, count: int = 5, force_download: bool = False) -> dict[str, Any]:
    """同步并索引最近活动，返回稳定的结构化结果。"""
    try:
        result = sync_garmin_activities_tool(count=count, force_download=force_download)
    except Exception as exc:
        return {
            "operation": "sync_recent",
            "status": "failed",
            "error": type(exc).__name__,
            "message": str(exc),
            "activities": [],
        }

    failed = int(result.get("failed") or 0)
    index_errors = [item for item in result.get("index_errors") or [] if isinstance(item, dict)]
    return {
        "operation": "sync_recent",
        "status": "partial" if failed or index_errors else "completed",
        "activities": result.get("indexed_items") or [],
        "downloaded": int(result.get("downloaded") or 0),
        "skipped": int(result.get("skipped") or 0),
        "failed": failed,
        "failed_items": result.get("failed_items") or [],
        "index_failed": len(index_errors),
        "index_errors": index_errors,
        "force_download": bool(force_download),
        "raw_result": result,
    }
