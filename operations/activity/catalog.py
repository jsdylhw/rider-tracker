"""活动目录查询操作。"""

from __future__ import annotations

from typing import Any

from services.activity.catalog import list_activities


def resolve_recent(*, limit: int = 5, order: str = "latest", sport_type: str | None = None) -> dict[str, Any]:
    """显式定位本地最近活动；不修改会话选择状态。"""
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0 or limit > 50:
        return _failed("invalid_limit", "limit must be an integer between 1 and 50")
    if order not in {"latest", "earliest"}:
        return _failed("invalid_order", "order must be latest or earliest")
    result = list_activities(limit=limit, order=order, sport_type=sport_type)
    return {
        "schema_version": "activity_operation_selection.v1",
        "operation": "resolve_recent",
        "status": "completed",
        "selection": {"kind": "recent", "limit": limit, "order": order, "sport_type": sport_type},
        "activities": result.get("activities") or [],
        "count": int(result.get("count") or 0),
    }


def _failed(error: str, message: str) -> dict[str, Any]:
    return {
        "schema_version": "activity_operation_selection.v1",
        "operation": "resolve_recent",
        "status": "failed",
        "error": error,
        "message": message,
        "activities": [],
        "count": 0,
    }
