"""运动员档案管理与区间计算。

档案支持 ``shared``、``cycling``、``running`` 三层。旧平铺字段仍兼容，
但旧 ``ftp`` 只视为骑行 FTP，绝不作为跑步功率阈值。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


DEFAULT_ATHLETE_PATH = Path("data") / "athlete.json"


def load_athlete_profile(path: str | Path = DEFAULT_ATHLETE_PATH) -> dict[str, Any]:
    """加载运动员档案,文件不存在返回空 dict."""
    target = Path(path)
    if not target.exists():
        return {}
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_athlete_profile(profile: dict[str, Any], path: str | Path = DEFAULT_ATHLETE_PATH) -> Path:
    """保存运动员档案."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def get_ftp(profile: dict[str, Any], *, sport_type: str = "cycling") -> float | None:
    """提取骑行 FTP(瓦)；跑步必须使用独立的 threshold_power_w。"""
    if _canonical_sport(sport_type) != "cycling":
        return None
    value = _sport_value(profile, "cycling", "ftp_w", "ftp")
    # 旧档案的平铺 ftp 只兼容为 cycling.ftp_w。
    return _number(value if value is not None else profile.get("ftp"))


def get_running_power_threshold(profile: dict[str, Any]) -> float | None:
    """提取跑步专属功率阈值；未配置时明确返回空。"""
    return _number(_sport_value(profile, "running", "threshold_power_w", "threshold_power"))


def get_running_threshold_pace(profile: dict[str, Any]) -> float | None:
    """提取跑步阈值配速（秒/公里）。"""
    return _number(_sport_value(profile, "running", "threshold_pace_s_per_km"))


def get_running_critical_speed(profile: dict[str, Any]) -> float | None:
    """提取跑步临界速度（米/秒）。"""
    return _number(_sport_value(profile, "running", "critical_speed_mps"))


def get_max_hr(profile: dict[str, Any], *, sport_type: str | None = None) -> float | None:
    """从档案中提取最大心率(bpm)."""
    return _number(_shared_or_sport_value(profile, sport_type, "max_heart_rate"))


def get_resting_hr(profile: dict[str, Any], *, sport_type: str | None = None) -> float | None:
    """从档案中提取静息心率(bpm)."""
    return _number(_shared_or_sport_value(profile, sport_type, "resting_heart_rate"))


def get_threshold_hr(profile: dict[str, Any], *, sport_type: str | None = None) -> float | None:
    """从档案中提取阈值心率(bpm)."""
    return _number(_shared_or_sport_value(profile, sport_type, "threshold_heart_rate"))


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _canonical_sport(sport_type: str | None) -> str:
    value = str(sport_type or "").lower()
    if "run" in value:
        return "running"
    if "cycl" in value or value in {"bike", "biking"}:
        return "cycling"
    return value


def _sport_value(profile: dict[str, Any], sport: str, *keys: str) -> Any:
    section = profile.get(sport)
    if not isinstance(section, dict):
        return None
    for key in keys:
        if section.get(key) is not None:
            return section[key]
    return None


def _shared_or_sport_value(profile: dict[str, Any], sport_type: str | None, key: str) -> Any:
    sport = _canonical_sport(sport_type) or "cycling"
    value = _sport_value(profile, sport, key) if sport else None
    if value is not None:
        return value
    shared = profile.get("shared")
    if isinstance(shared, dict) and shared.get(key) is not None:
        return shared[key]
    return profile.get(key)


# -- 功率区间 (Coggan 7 区) ---------------------------------------------------

def power_zone_boundaries(ftp: float) -> list[float]:
    """返回 Coggan 功率区间上界列表(瓦).

    区间定义(占 FTP 百分比):
      Z1 恢复     < 55%
      Z2 耐力   55-75%
      Z3 节奏   75-90%
      Z4 阈值   90-105%
      Z5 VO2Max 105-120%
      Z6 无氧   120-150%
      Z7 冲刺      > 150%

    返回 6 个上界: [0.55*ftp, 0.75*ftp, 0.90*ftp, 1.05*ftp, 1.20*ftp, 1.50*ftp]
    """
    ftp = float(ftp)
    return [round(ftp * pct, 1) for pct in (0.55, 0.75, 0.90, 1.05, 1.20, 1.50)]


# -- 心率区间 (5 区模型,基于最大心率百分比) ------------------------------------

def hr_zone_boundaries(max_hr: float, *, resting_hr: float | None = None) -> list[float]:
    """返回心率区间上界列表(bpm).

    采用储备心率(HRR)百分比模型,若缺静息心率则退化为最大心率百分比:
      Z1 恢复  < 60% (HRR) / < 60% MHR
      Z2 耐力  60-70%
      Z3 节奏  70-80%
      Z4 阈值  80-90%
      Z5 最大  90-100%

    返回 4 个上界.
    """
    max_hr_f = float(max_hr)
    if resting_hr is not None:
        reserve = max_hr_f - float(resting_hr)
        return [round(float(resting_hr) + reserve * pct, 1) for pct in (0.60, 0.70, 0.80, 0.90)]
    return [round(max_hr_f * pct, 1) for pct in (0.60, 0.70, 0.80, 0.90)]


# -- 从 FIT training_metadata 中提取已有值 ------------------------------------

def _has_ftp(metadata: dict[str, Any]) -> bool:
    zones = metadata.get("zones_target") or {}
    return zones.get("functional_threshold_power") is not None


def _has_max_hr(metadata: dict[str, Any], *, sport_type: str | None = None) -> bool:
    zones = metadata.get("zones_target") or {}
    user_profile = metadata.get("user_profile") or {}
    return (
        zones.get("max_heart_rate") is not None
        or ((_canonical_sport(sport_type) or "cycling") == "cycling" and user_profile.get("default_max_biking_heart_rate") is not None)
        or user_profile.get("default_max_heart_rate") is not None
    )


def _has_hr_zones(metadata: dict[str, Any]) -> bool:
    """检查 time_in_zone 中是否已有心率区间边界."""
    tiz = metadata.get("time_in_zone") or []
    for entry in tiz:
        if entry.get("hr_zone_high_boundary") is not None:
            return True
    return False


def _has_power_zones(metadata: dict[str, Any]) -> bool:
    """检查 time_in_zone 中是否已有功率区间边界."""
    tiz = metadata.get("time_in_zone") or []
    for entry in tiz:
        if entry.get("power_zone_high_boundary") is not None:
            return True
    return False


# -- 主入口:用运动员档案补全 training_metadata ---------------------------------

def enrich_training_metadata(
    metadata: dict[str, Any],
    profile: dict[str, Any] | None = None,
    *,
    sport_type: str | None = None,
) -> dict[str, Any]:
    """用运动员档案补全 FIT training_metadata 中缺失的 FTP/心率/区间设定.

    Args:
        metadata: FIT summarize_training_metadata() 的返回值.
        profile: load_athlete_profile() 的返回值,传 None 则自动加载.

    Returns:
        dict: 补全后的 metadata 副本.
    """
    if profile is None:
        profile = load_athlete_profile()
    if not profile:
        return metadata

    enriched = _deep_copy_metadata(metadata)
    # 未传 sport_type 是旧调用方式，保持其原本“骑行分析”的含义。
    sport = _canonical_sport(sport_type) or "cycling"
    is_cycling = sport == "cycling"
    is_running = sport == "running"
    ftp = get_ftp(profile, sport_type=sport)
    running_power_threshold = get_running_power_threshold(profile) if is_running else None
    running_threshold_pace = get_running_threshold_pace(profile) if is_running else None
    running_critical_speed = get_running_critical_speed(profile) if is_running else None
    max_hr = get_max_hr(profile, sport_type=sport)
    resting_hr = get_resting_hr(profile, sport_type=sport)
    threshold_hr = get_threshold_hr(profile, sport_type=sport)

    # 补 zones_target
    zones = enriched.setdefault("zones_target", {})
    if is_cycling and not _has_ftp(enriched) and ftp is not None:
        zones["functional_threshold_power"] = ftp
        zones["pwr_calc_type"] = "athlete_profile"
    if not _has_max_hr(enriched, sport_type=sport) and max_hr is not None:
        zones["max_heart_rate"] = max_hr
        zones["hr_calc_type"] = "athlete_profile"
    if zones.get("threshold_heart_rate") is None and threshold_hr is not None:
        zones["threshold_heart_rate"] = threshold_hr

    # 补 time_in_zone 区间边界
    tiz = enriched.setdefault("time_in_zone", [])
    if is_cycling and not _has_power_zones(enriched) and ftp is not None:
        boundaries = power_zone_boundaries(ftp)
        tiz.append({
            "reference_mesg": "athlete_profile",
            "reference_index": 0,
            "functional_threshold_power": ftp,
            "pwr_calc_type": "coggan_7_zone",
            "power_zone_high_boundary": boundaries,
        })
    if not _has_hr_zones(enriched) and max_hr is not None:
        boundaries = hr_zone_boundaries(max_hr, resting_hr=resting_hr)
        tiz.append({
            "reference_mesg": "athlete_profile",
            "reference_index": 0,
            "max_heart_rate": max_hr,
            "resting_heart_rate": resting_hr,
            "hr_calc_type": "heart_rate_reserve" if resting_hr is not None else "max_hr_percent",
            "hr_zone_high_boundary": boundaries,
        })

    # 补 user_profile 基础字段
    profile_fields = {
        "resting_heart_rate": resting_hr,
        "weight": profile.get("weight"),
        "height": profile.get("height"),
    }
    user_profile = enriched.setdefault("user_profile", {})
    for key, value in profile_fields.items():
        if value is not None and user_profile.get(key) is None:
            user_profile[key] = value

    # 跑步功率阈值必须由 running profile 显式提供。FIT 的
    # functional_threshold_power 可能是 Garmin 设备保留的骑行设置，保留原始值
    # 供追溯，但不把它作为分析阈值。
    if is_running:
        analysis_profile = enriched.setdefault("analysis_profile", {})
        analysis_profile["running_power_threshold_w"] = running_power_threshold
        analysis_profile["running_power_threshold_source"] = (
            "athlete_profile.running" if running_power_threshold is not None else "unavailable"
        )
        analysis_profile["running_threshold_pace_s_per_km"] = running_threshold_pace
        analysis_profile["running_threshold_pace_source"] = (
            "athlete_profile.running" if running_threshold_pace is not None else "unavailable"
        )
        analysis_profile["running_critical_speed_mps"] = running_critical_speed
        analysis_profile["running_critical_speed_source"] = (
            "athlete_profile.running" if running_critical_speed is not None else "unavailable"
        )

    return enriched


def _deep_copy_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """浅拷贝足够,因为 metadata 值都是基础类型或 list[dict]."""
    import copy
    return copy.deepcopy(metadata)
