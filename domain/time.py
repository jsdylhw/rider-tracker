"""时间格式工具."""

from __future__ import annotations

from datetime import datetime
from typing import Any


def local_time_without_timezone(value: Any) -> str | None:
    """Normalize an ISO-ish time to local wall-clock format without +08:00/Z."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is not None:
            dt = dt.astimezone(datetime.now().astimezone().tzinfo)
        return dt.replace(tzinfo=None).isoformat(timespec="seconds")
    text = str(value)
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return _strip_timezone_suffix(text)
    if dt.tzinfo is not None:
        dt = dt.astimezone(datetime.now().astimezone().tzinfo)
    return dt.replace(tzinfo=None).isoformat(timespec="seconds")


def _strip_timezone_suffix(value: str) -> str:
    if value.endswith("Z"):
        return value[:-1]
    if len(value) >= 6 and value[-6] in {"+", "-"} and value[-3] == ":":
        return value[:-6]
    return value
