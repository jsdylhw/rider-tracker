"""Typed contracts for resolving activities from the local catalogue."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar


SELECTION_KINDS = {"current", "recent", "date", "range", "all", "key", "index", "name"}
SELECTION_ORDERS = {"latest", "earliest", "longest"}
RELATIVE_RANGES = {"this_week", "this_month", "last_week", "last_month"}


@dataclass(frozen=True)
class ActivitySelectionRequest:
    """A validated, explicit activity selection requested by the Main Agent.

    ``kind`` is authoritative.  The resolver never guesses a mode from which
    optional fields happen to be present; incompatible fields are rejected.
    """

    kind: str
    activity_key: str | None = None
    activity_index: int | None = None
    name: str | None = None
    date: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    relative_range: str | None = None
    days: int | None = None
    sport_type: str | None = None
    time_of_day: str | None = None
    order: str = "latest"
    limit: int | None = None

    _COMMON: ClassVar[set[str]] = {"kind", "sport_type", "time_of_day", "order", "limit"}
    _ALLOWED_BY_KIND: ClassVar[dict[str, set[str]]] = {
        "current": {"kind"},
        "recent": _COMMON,
        "date": _COMMON | {"date"},
        "range": _COMMON | {"start_date", "end_date", "relative_range", "days"},
        "all": _COMMON,
        "key": {"kind", "activity_key"},
        "index": {"kind", "activity_index"},
        "name": _COMMON | {"name"},
    }

    @classmethod
    def from_arguments(cls, arguments: dict[str, Any]) -> "ActivitySelectionRequest":
        """Parse tool arguments while rejecting ambiguous mixed selectors."""
        if not isinstance(arguments, dict):
            raise ValueError("activity selection must be an object")
        kind = str(arguments.get("kind") or "").strip().lower()
        if kind not in SELECTION_KINDS:
            raise ValueError(f"kind must be one of: {', '.join(sorted(SELECTION_KINDS))}")

        supplied = {key for key, value in arguments.items() if value is not None}
        unknown = supplied - cls._ALLOWED_BY_KIND[kind]
        if unknown:
            raise ValueError(f"{kind} selection does not allow: {', '.join(sorted(unknown))}")

        request = cls(
            kind=kind,
            activity_key=_text(arguments.get("activity_key")),
            activity_index=_positive_int(arguments.get("activity_index"), field="activity_index"),
            name=_text(arguments.get("name")),
            date=_text(arguments.get("date")),
            start_date=_text(arguments.get("start_date")),
            end_date=_text(arguments.get("end_date")),
            relative_range=_text(arguments.get("relative_range")),
            days=_positive_int(arguments.get("days"), field="days"),
            sport_type=_text(arguments.get("sport_type")),
            time_of_day=_text(arguments.get("time_of_day")),
            order=str(arguments.get("order") or "latest").strip().lower(),
            limit=_positive_int(arguments.get("limit"), field="limit"),
        )
        request._validate()
        return request

    def _validate(self) -> None:
        if self.order not in SELECTION_ORDERS:
            raise ValueError("order must be latest, earliest, or longest")
        if self.limit is not None and self.limit > 50:
            raise ValueError("limit must be between 1 and 50")
        if self.days is not None and self.days > 3650:
            raise ValueError("days must be between 1 and 3650")

        required = {
            "key": ("activity_key", self.activity_key),
            "index": ("activity_index", self.activity_index),
            "name": ("name", self.name),
            "date": ("date", self.date),
        }
        if self.kind in required and required[self.kind][1] is None:
            raise ValueError(f"{self.kind} selection requires {required[self.kind][0]}")
        if self.kind == "range":
            families = sum((
                bool(self.start_date or self.end_date),
                bool(self.relative_range),
                self.days is not None,
            ))
            if families != 1:
                raise ValueError("range selection requires exactly one date range form")
            if self.relative_range and self.relative_range not in RELATIVE_RANGES:
                raise ValueError(f"relative_range must be one of: {', '.join(sorted(RELATIVE_RANGES))}")

    def to_dict(self) -> dict[str, Any]:
        values = {
            "kind": self.kind,
            "activity_key": self.activity_key,
            "activity_index": self.activity_index,
            "name": self.name,
            "date": self.date,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "relative_range": self.relative_range,
            "days": self.days,
            "sport_type": self.sport_type,
            "time_of_day": self.time_of_day,
            "order": self.order,
            "limit": self.limit,
        }
        return {key: value for key, value in values.items() if value is not None}


@dataclass(frozen=True)
class ActivitySelectionResult:
    """One uniform ordered-list result for both single and multi selection."""

    request: dict[str, Any]
    activities: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "activity_selection",
            "request": self.request,
            "count": len(self.activities),
            "activities": self.activities,
        }


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _positive_int(value: Any, *, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return value
