""".fit 文件解析:将 Garmin FIT 二进制格式转为标准 dict 和 DataFrame.

parse_fit() 是主入口,返回 records/laps/sessions/sports/training_metadata.
records_dataframe() 将 records 转为 pandas DataFrame 并自动计算 elapsed_s 列.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fitdecode
import pandas as pd

# FIT 文件中包含训练元数据的 message 类型
TRAINING_MESSAGE_NAMES = {
    "training_settings",
    "zones_target",
    "time_in_zone",
    "hrv",
    "user_profile",
    "device_info",
    "device_settings",
    "event",
    "split",
    "split_summary",
}


def _field_dict(frame: fitdecode.FitDataMessage) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for field in frame.fields:
        values[field.name] = _clean_value(field.value)
    return values


def parse_fit(path: str | Path, *, athlete_profile: dict[str, Any] | None = None) -> dict[str, Any]:
    """解析 FIT 文件,返回标准化的活动数据结构.

    Args:
        path: .fit 文件路径.

    Returns:
        dict: {
            path, summary, records, laps, sessions, sports, training_metadata
        }
        summary 包含 sport_type, start_time*, duration_s, distance_m 等字段.
        training_metadata 包含 zones_target, user_profile, device_info 等.
    """
    fit_path = Path(path)
    records: list[dict[str, Any]] = []
    laps: list[dict[str, Any]] = []
    sessions: list[dict[str, Any]] = []
    sports: list[dict[str, Any]] = []
    training_messages: dict[str, list[dict[str, Any]]] = {
        name: [] for name in sorted(TRAINING_MESSAGE_NAMES)
    }

    with fitdecode.FitReader(str(fit_path)) as fit:
        for frame in fit:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            values = _field_dict(frame)
            if frame.name == "record":
                records.append(values)
            elif frame.name == "lap":
                laps.append(values)
            elif frame.name == "session":
                sessions.append(values)
            elif frame.name == "sport":
                sports.append(values)
            if frame.name in training_messages:
                training_messages[frame.name].append(values)

    summary = summarize_fit(records, laps, sessions, sports)
    training_metadata = summarize_training_metadata(training_messages)
    training_metadata = _enrich_with_athlete_profile(
        training_metadata, profile=athlete_profile, sport_type=summary.get("sport_type"),
    )
    return {
        "path": str(fit_path),
        "summary": summary,
        "records": records,
        "laps": laps,
        "sessions": sessions,
        "sports": sports,
        "training_metadata": training_metadata,
    }


def summarize_fit(
    records: list[dict[str, Any]],
    laps: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    sports: list[dict[str, Any]],
) -> dict[str, Any]:
    """从解析结果中提取活动基础摘要.

    优先用 session 数据(含 Garmin 计算的 NP/TSS/IF),
    回退到 records 首尾采样.
    """
    session = sessions[-1] if sessions else {}
    sport_msg = sports[-1] if sports else {}
    first_record = records[0] if records else {}
    last_record = records[-1] if records else {}

    # start_time 优先取 session,其次首条 record 的 timestamp
    start = (
        session.get("start_time")
        or first_record.get("timestamp")
        or session.get("timestamp")
    )
    duration_s = session.get("total_timer_time") or session.get("total_elapsed_time")
    distance_m = session.get("total_distance") or last_record.get("distance")

    return {
        "sport_type": str(session.get("sport") or sport_msg.get("sport") or "unknown"),
        "sub_sport": str(session.get("sub_sport") or sport_msg.get("sub_sport") or ""),
        "start_time": _iso(start),
        "start_time_utc": _utc_iso(start),
        # 注意:_local_iso 使用服务器本地时区,只能作为近似值
        "start_time_local": _local_iso(start),
        "timezone_note": "start_time is UTC; use start_time_local for user-facing reports.",
        "duration_s": _num(duration_s),
        "distance_m": _num(distance_m),
        "record_count": len(records),
        "lap_count": len(laps),
        "has_power": any("power" in r for r in records),
        "has_heart_rate": any("heart_rate" in r for r in records),
        "has_position": any("position_lat" in r and "position_long" in r for r in records),
    }


def records_dataframe(records: list[dict[str, Any]]) -> pd.DataFrame:
    """将 records 转为 DataFrame,按 timestamp 排序并计算 elapsed_s 列.

    这是所有区间聚合工具的数据基础.
    """
    df = pd.DataFrame(records)
    if df.empty:
        return df
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df = df.sort_values("timestamp")
        df["elapsed_s"] = (df["timestamp"] - df["timestamp"].iloc[0]).dt.total_seconds()
    return df


def summarize_training_metadata(messages: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """从 FIT training messages 中提取训练元数据.

    包括:训练设置,区间定义,各区时间,用户画像,设备信息,事件,分段.
    所有字段都是保留原始 FIT 数据中已有的 key,做 key 精简和清理.
    """
    return {
        "message_counts": {
            name: len(rows) for name, rows in messages.items() if rows
        },
        "training_settings": _select_keys(
            _last(messages.get("training_settings")) or {},
            ["target_distance", "target_speed", "target_time"],
        ),
        "zones_target": _select_keys(
            _last(messages.get("zones_target")) or {},
            [
                "functional_threshold_power", "max_heart_rate",
                "threshold_heart_rate", "hr_calc_type", "pwr_calc_type",
            ],
        ),
        "time_in_zone": [_compact_time_in_zone(row) for row in messages.get("time_in_zone", [])],
        "hrv": _summarize_hrv(messages.get("hrv", [])),
        "user_profile": _compact_user_profile(_last(messages.get("user_profile")) or {}),
        "device_info": [_compact_device_info(row) for row in messages.get("device_info", [])],
        "device_settings": _select_keys(
            _last(messages.get("device_settings")) or {},
            ["lactate_threshold_autodetect_enabled", "activity_tracker_enabled", "move_alert_enabled"],
        ),
        "events": [_compact_event(row) for row in messages.get("event", [])],
        "splits": [_compact_split(row) for row in messages.get("split", [])],
        "split_summary": [_compact_split(row) for row in messages.get("split_summary", [])],
    }


def _summarize_hrv(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = [_num(row.get("time")) for row in rows]
    values = [value for value in values if value is not None]
    if not values:
        return {"count": len(rows)}
    return {
        "count": len(rows),
        "time_min": min(values),
        "time_max": max(values),
        "time_avg": sum(values) / len(values),
    }


def _last(rows: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    return rows[-1] if rows else None


def _select_keys(row: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    return {key: row.get(key) for key in keys if key in row}


def _compact_time_in_zone(row: dict[str, Any]) -> dict[str, Any]:
    return _select_keys(row, [
        "timestamp", "reference_mesg", "reference_index",
        "functional_threshold_power", "max_heart_rate", "resting_heart_rate",
        "threshold_heart_rate", "hr_calc_type", "pwr_calc_type",
        "hr_zone_high_boundary", "power_zone_high_boundary",
        "time_in_hr_zone", "time_in_power_zone",
    ])


def _compact_user_profile(row: dict[str, Any]) -> dict[str, Any]:
    return _select_keys(row, [
        "friendly_name", "gender", "age", "height", "weight",
        "resting_heart_rate", "default_max_biking_heart_rate", "default_max_heart_rate",
        "hr_setting", "power_setting", "activity_class",
    ])


def _compact_device_info(row: dict[str, Any]) -> dict[str, Any]:
    return _select_keys(row, [
        "timestamp", "manufacturer", "garmin_product", "product",
        "software_version", "device_index", "local_device_type",
        "antplus_device_type", "source_type", "battery_status", "battery_level",
    ])


def _compact_event(row: dict[str, Any]) -> dict[str, Any]:
    return _select_keys(row, [
        "timestamp", "event", "event_type", "timer_trigger", "event_group", "data",
    ])


def _compact_split(row: dict[str, Any]) -> dict[str, Any]:
    return _select_keys(row, [
        "message_index", "split_type", "start_time", "end_time",
        "total_elapsed_time", "total_timer_time", "total_distance",
        "avg_speed", "max_speed", "avg_heart_rate", "max_heart_rate",
        "total_ascent", "total_descent", "total_calories", "num_splits",
    ])


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _utc_iso(value: Any) -> str | None:
    dt = _parse_datetime(value)
    if dt is None:
        return _iso(value)
    return dt.astimezone(timezone.utc).isoformat()


def _local_iso(value: Any) -> str | None:
    """转为服务器本地时区——这是近似值,不代表活动实际发生的时区."""
    dt = _parse_datetime(value)
    if dt is None:
        return None
    local_tz = datetime.now().astimezone().tzinfo
    return dt.astimezone(local_tz).replace(tzinfo=None).isoformat(timespec="seconds")


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _clean_value(value: Any) -> Any:
    """递归清洗 FIT 字段值:datetime → iso string,未知类型 → str."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_clean_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _clean_value(item) for key, item in value.items()}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _enrich_with_athlete_profile(
    metadata: dict[str, Any], *, profile: dict[str, Any] | None = None,
    sport_type: str | None = None,
) -> dict[str, Any]:
    """用共享数据库运动员档案补全 FIT 中缺失的 FTP/心率/区间设定."""
    from domain.athlete import enrich_training_metadata
    return enrich_training_metadata(metadata, profile or {}, sport_type=sport_type)
