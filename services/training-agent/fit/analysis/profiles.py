"""运动专项能力与指标边界。

这里不负责解析或生成报告；它只给 FIT 工具一个统一的运动类型判断，防止
骑行的 FTP/功率区间被意外用于跑步。
"""

from __future__ import annotations

from typing import Any


def canonical_sport(sport_type: Any) -> str:
    """将 FIT 中不稳定的 sport 字符串归一为当前支持的专项类型。"""
    value = str(sport_type or "").strip().lower()
    if "run" in value:
        return "running"
    if value in {"cycling", "bike", "biking"} or "cycl" in value:
        return "cycling"
    return value or "unknown"


def is_running(sport_type: Any) -> bool:
    return canonical_sport(sport_type) == "running"


def is_cycling(sport_type: Any) -> bool:
    return canonical_sport(sport_type) == "cycling"


def supports_cycling_power_metrics(sport_type: Any) -> bool:
    """IF/TSS/Coggan 功率区间只属于骑行专项。

    Garmin FIT 的 functional_threshold_power 可能来自设备或账户的全局设置，
    对跑步没有足够的专项语义，故不能据此开启这些指标。
    """
    return is_cycling(sport_type)
