"""Pure, typed activity resolution over the SQLite activity catalogue."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from domain.activity.models import ActivityHandle
from domain.activity.selection import ActivitySelectionRequest, ActivitySelectionResult
from storage.repositories.activity import ActivityStore


class ActivityResolver:
    """Resolve a validated request without mutating Agent or navigation state."""

    def __init__(self, path: str | Path | None = None):
        self.store = ActivityStore(path)

    def resolve(
        self,
        request: ActivitySelectionRequest,
        *,
        today: date | None = None,
        current_activity_ids: Iterable[str] = (),
    ) -> ActivitySelectionResult:
        rows = self._indexed_rows()
        resolved_request = request.to_dict()

        if request.kind == "current":
            wanted = [str(value) for value in current_activity_ids if str(value)]
            by_id = {str(row.get("activity_key") or ""): row for row in rows}
            selected = [by_id[value] for value in wanted if value in by_id]
            return ActivitySelectionResult(resolved_request, self._compact(selected))

        rows = _filter_common(
            rows,
            sport_type=request.sport_type,
            time_of_day=request.time_of_day,
        )
        current = today or date.today()

        if request.kind == "key":
            rows = [row for row in rows if str(row.get("activity_key") or "") == request.activity_key]
        elif request.kind == "index":
            rows = [row for row in rows if row.get("activity_index") == request.activity_index]
        elif request.kind == "name":
            needle = _normalize_text(request.name)
            rows = [row for row in rows if needle in _normalize_text(row.get("file_name") or row.get("name"))]
        elif request.kind == "date":
            resolved_date = _resolve_date(str(request.date), today=current)
            resolved_request["date"] = resolved_date
            rows = [row for row in rows if str(row.get("date_local") or "") == resolved_date]
        elif request.kind == "range":
            start_date, end_date = _resolve_range(request, today=current)
            resolved_request.pop("relative_range", None)
            resolved_request.pop("days", None)
            resolved_request.update({"start_date": start_date, "end_date": end_date})
            rows = [
                row for row in rows
                if row.get("date_local") and start_date <= str(row["date_local"]) <= end_date
            ]
        # ``recent`` and ``all`` need only common filtering and ordering.

        rows = _ordered(rows, request.order)
        limit = request.limit
        if request.kind == "recent" and limit is None:
            limit = 1
            resolved_request["limit"] = 1
        if limit is not None:
            rows = rows[:limit]
        return ActivitySelectionResult(resolved_request, self._compact(rows))

    def _indexed_rows(self) -> list[dict[str, Any]]:
        rows = self.store.list_activity_entries()
        ordered = sorted(rows, key=_row_order_key)
        return [{**row, "activity_index": index} for index, row in enumerate(ordered, start=1)]

    @staticmethod
    def _compact(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [ActivityHandle.from_index_entry(row).to_dict() for row in rows]


def _filter_common(
    rows: list[dict[str, Any]],
    *,
    sport_type: str | None,
    time_of_day: str | None,
) -> list[dict[str, Any]]:
    sport = _canonical_sport_type(sport_type)
    part_of_day = _canonical_time_of_day(time_of_day)
    result = rows
    if sport:
        result = [row for row in result if _canonical_sport_type(row.get("sport_type")) == sport]
    if part_of_day:
        result = [row for row in result if _matches_time_of_day(row, part_of_day)]
    return result


def _ordered(rows: list[dict[str, Any]], order: str) -> list[dict[str, Any]]:
    if order == "longest":
        return sorted(rows, key=_duration_order_key, reverse=True)
    result = sorted(rows, key=_row_order_key)
    return result if order == "earliest" else list(reversed(result))


def _row_order_key(row: dict[str, Any]) -> tuple[str, str]:
    return str(row.get("start_time_local") or ""), str(row.get("file_name") or "")


def _duration_order_key(row: dict[str, Any]) -> tuple[float, tuple[str, str]]:
    value = row.get("duration_min")
    if value is None and row.get("duration_s") is not None:
        try:
            value = float(row["duration_s"]) / 60
        except (TypeError, ValueError):
            value = None
    try:
        duration = float(value) if value is not None else -1.0
    except (TypeError, ValueError):
        duration = -1.0
    return duration, _row_order_key(row)


def _resolve_date(value: str, *, today: date) -> str:
    normalized = value.strip().lower()
    if normalized in {"today", "今天"}:
        return today.isoformat()
    if normalized in {"yesterday", "昨天"}:
        return (today - timedelta(days=1)).isoformat()
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError("date must be today, yesterday, or an ISO date") from exc


def _resolve_range(request: ActivitySelectionRequest, *, today: date) -> tuple[str, str]:
    if request.days is not None:
        return (today - timedelta(days=request.days - 1)).isoformat(), today.isoformat()
    if request.relative_range:
        return _relative_range(request.relative_range, today=today)
    start = _iso_date(request.start_date, field="start_date") if request.start_date else "0001-01-01"
    end = _iso_date(request.end_date, field="end_date") if request.end_date else today.isoformat()
    if start > end:
        raise ValueError("start_date must not be after end_date")
    return start, end


def _relative_range(value: str, *, today: date) -> tuple[str, str]:
    if value == "this_week":
        return (today - timedelta(days=today.weekday())).isoformat(), today.isoformat()
    if value == "last_week":
        this_week = today - timedelta(days=today.weekday())
        return (this_week - timedelta(days=7)).isoformat(), (this_week - timedelta(days=1)).isoformat()
    if value == "this_month":
        return today.replace(day=1).isoformat(), today.isoformat()
    first_this_month = today.replace(day=1)
    last_previous_month = first_this_month - timedelta(days=1)
    return last_previous_month.replace(day=1).isoformat(), last_previous_month.isoformat()


def _iso_date(value: str, *, field: str) -> str:
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO date") from exc


def _canonical_sport_type(value: Any) -> str | None:
    text = "".join(str(value or "").strip().lower().split())
    aliases = {
        "cycling": "cycling", "ride": "cycling", "骑行": "cycling", "公路骑行": "cycling",
        "running": "running", "run": "running", "跑步": "running",
        "walking": "walking", "walk": "walking", "徒步": "walking", "hiking": "walking",
    }
    return aliases.get(text, text or None)


def _canonical_time_of_day(value: Any) -> str | None:
    aliases = {
        "morning": "morning", "上午": "morning", "早上": "morning", "清晨": "morning",
        "afternoon": "afternoon", "下午": "afternoon",
        "evening": "evening", "傍晚": "evening", "晚上": "evening",
        "night": "night", "夜间": "night", "深夜": "night",
    }
    return aliases.get(str(value or "").strip().lower())


def _matches_time_of_day(row: dict[str, Any], part_of_day: str) -> bool:
    try:
        hour = datetime.fromisoformat(str(row.get("start_time_local") or "")).hour
    except ValueError:
        return False
    if part_of_day == "morning":
        return 4 <= hour < 12
    if part_of_day == "afternoon":
        return 12 <= hour < 18
    if part_of_day == "evening":
        return 18 <= hour < 22
    return hour >= 22 or hour < 4


def _normalize_text(value: Any) -> str:
    return "".join(str(value or "").lower().split())
