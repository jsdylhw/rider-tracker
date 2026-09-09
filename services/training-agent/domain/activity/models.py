"""活动领域模型:ActivityHandle 统一活动引用.

替代直接传 fit_path / activity_key / date_local 等散落字段.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from domain.analysis.artifacts import get_index_load_label
from project_paths import resolve_project_path


@dataclass(frozen=True)
class ActivityHandle:
    """一条本地活动的统一引用.

    所有分析、对比、上传链路围绕此结构传递,
    不再直接散落 fit_path / activity_key 等字段.
    """

    activity_key: str
    activity_index: int | None = None
    fit_path: str | None = None
    file_name: str | None = None
    start_time_local: str | None = None
    date_local: str | None = None
    sport_type: str | None = None
    duration_min: float | None = None
    distance_km: float | None = None
    summary_label: str | None = None
    main_stimulus: str | None = None
    load_label: str | None = None
    has_summary: bool = False
    sub_sport: str | None = None
    source: str | None = None
    has_strava_summary: bool = False

    @classmethod
    def from_index_entry(cls, entry: dict[str, Any]) -> "ActivityHandle":
        """从 SQLite 活动目录的一行创建。"""
        return cls(
            activity_key=str(entry.get("activity_key") or ""),
            activity_index=_int_or_none(entry.get("activity_index")),
            fit_path=entry.get("fit_path"),
            file_name=entry.get("file_name"),
            start_time_local=entry.get("start_time_local"),
            date_local=entry.get("date_local"),
            sport_type=entry.get("sport_type"),
            sub_sport=entry.get("sub_sport"),
            duration_min=_float_or_none(entry.get("duration_min")),
            distance_km=_float_or_none(entry.get("distance_km")),
            summary_label=entry.get("summary_label"),
            main_stimulus=entry.get("main_stimulus"),
            load_label=get_index_load_label(entry),
            has_summary=bool(entry.get("has_summary")),
            has_strava_summary=bool(entry.get("has_strava_summary")),
            source=entry.get("source"),
        )

    def to_dict(self) -> dict[str, Any]:
        """返回工具层使用的紧凑 dict。"""
        d = {
            "activity_key": self.activity_key,
            "activity_index": self.activity_index,
            "file_name": self.file_name,
            "fit_path": self.fit_path,
            "start_time_local": self.start_time_local,
            "date_local": self.date_local,
            "sport_type": self.sport_type,
            "sub_sport": self.sub_sport,
            "duration_min": self.duration_min,
            "distance_km": self.distance_km,
            "summary_label": self.summary_label,
            "main_stimulus": self.main_stimulus,
            "load_label": self.load_label,
            "has_summary": self.has_summary,
            "has_strava_summary": self.has_strava_summary,
            "source": self.source,
        }
        return {k: v for k, v in d.items() if v is not None}

    @property
    def fit_path_obj(self) -> Path | None:
        if self.fit_path:
            return resolve_project_path(self.fit_path)
        return None


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
