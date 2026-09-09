"""跑步专项的单位归一与跑姿数据输出。"""

from __future__ import annotations

from typing import Any

from fit.analysis.stats import _round_float, _select_stats
from fit.parser import records_dataframe


def cadence_to_spm(value: Any) -> float | None:
    """Garmin record cadence 对跑步是每分钟跨步周期，面向用户应为 steps/min。"""
    numeric = _round_float(value, 3)
    return _round_float(numeric * 2, 1) if numeric is not None else None


def build_running_dynamics(stats: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """返回已归一单位的跑姿指标，并保留原始统计量供追溯。"""
    fields = (
        "vertical_oscillation", "stance_time", "stance_time_percent",
        "step_length", "stride_length", "vertical_ratio",
    )
    record_fields = {field: _select_stats(stats, field) for field in fields if _select_stats(stats, field)}

    def avg(field: str) -> float | None:
        return _round_float((record_fields.get(field) or {}).get("avg"), 3)

    step_length = avg("step_length")
    stride_length = avg("stride_length")
    return {
        "available": bool(record_fields),
        "record_fields": record_fields,
        "summary": {
            "vertical_oscillation_mm": avg("vertical_oscillation"),
            "stance_time_ms": avg("stance_time"),
            "stance_time_percent": avg("stance_time_percent"),
            "vertical_ratio_percent": avg("vertical_ratio"),
            "step_length_m": _length_to_m(step_length),
            "stride_length_m": _length_to_m(stride_length),
        },
        "note": "Only recorded FIT running-dynamics fields are returned; units are normalized for analysis.",
    }


def analyze_running_efficiency(records: list[dict[str, Any]]) -> dict[str, Any]:
    """对比活动前后 30% 的有效跑步数据，提供跑步专项的稳定性输入。

    这是确定性数据汇总，不把配速/心率变化直接解释成疲劳；路线坡度、停顿和
    环境因素仍需由报告层结合上下文判断。
    """
    df = records_dataframe(records)
    speed_column = "enhanced_speed" if "enhanced_speed" in df.columns else "speed"
    if df.empty or "elapsed_s" not in df.columns or speed_column not in df.columns:
        return {
            "kind": "running_efficiency",
            "available": False,
            "reason": "Running efficiency requires timestamped speed records.",
        }

    active = df[df[speed_column].notna() & (df[speed_column].astype(float) > 0)].copy()
    if len(active) < 12:
        return {
            "kind": "running_efficiency",
            "available": False,
            "reason": "Too few active running records for an early/late comparison.",
            "active_record_count": int(len(active)),
        }

    start = float(active["elapsed_s"].min())
    end = float(active["elapsed_s"].max())
    span = end - start
    if span <= 0:
        return {
            "kind": "running_efficiency",
            "available": False,
            "reason": "Running records have no usable elapsed-time span.",
        }

    early = active[active["elapsed_s"] <= start + span * 0.30]
    late = active[active["elapsed_s"] >= start + span * 0.70]
    if len(early) < 4 or len(late) < 4:
        return {
            "kind": "running_efficiency",
            "available": False,
            "reason": "Too few records in the early or late comparison window.",
        }

    early_metrics = _running_window_metrics(early, speed_column)
    late_metrics = _running_window_metrics(late, speed_column)
    early_pace = early_metrics.get("avg_pace_s_per_km")
    late_pace = late_metrics.get("avg_pace_s_per_km")
    pace_change = _difference(late_pace, early_pace)
    return _drop_none({
        "kind": "running_efficiency",
        "available": True,
        "comparison_basis": "first_last_active_30_percent",
        "active_record_count": int(len(active)),
        "early": early_metrics,
        "late": late_metrics,
        "change": {
            # 正值代表后段更慢，负值代表后段更快。
            "pace_change_s_per_km": pace_change,
            "pace_change_percent": _ratio(pace_change, early_pace),
            "heart_rate_change_bpm": _difference(late_metrics.get("avg_hr_bpm"), early_metrics.get("avg_hr_bpm")),
            "cadence_change_spm": _difference(late_metrics.get("avg_cadence_spm"), early_metrics.get("avg_cadence_spm")),
            "step_length_change_m": _difference(late_metrics.get("avg_step_length_m"), early_metrics.get("avg_step_length_m")),
        },
        "data_quality": {
            "has_heart_rate": "heart_rate" in active.columns,
            "has_cadence": "cadence" in active.columns,
            "has_step_length": "step_length" in active.columns,
            "limitation": "Pace and heart-rate drift are not terrain-, weather-, or stop-normalized.",
        },
    })


def _running_window_metrics(df: Any, speed_column: str) -> dict[str, Any]:
    speed = _mean(df, speed_column)
    return _drop_none({
        "record_count": int(len(df)),
        "avg_speed_mps": _round_float(speed, 3),
        "avg_pace_s_per_km": _pace_seconds_per_km(speed),
        "avg_hr_bpm": _round_float(_mean(df, "heart_rate"), 1),
        "avg_cadence_spm": cadence_to_spm(_mean(df, "cadence")),
        "avg_step_length_m": _length_to_m(_mean(df, "step_length")),
        "avg_vertical_oscillation_mm": _round_float(_mean(df, "vertical_oscillation"), 1),
        "avg_stance_time_ms": _round_float(_mean(df, "stance_time"), 1),
    })


def _mean(df: Any, column: str) -> float | None:
    if column not in df.columns:
        return None
    values = df[column].dropna()
    if values.empty:
        return None
    try:
        return float(values.astype(float).mean())
    except (TypeError, ValueError):
        return None


def _pace_seconds_per_km(speed_mps: float | None) -> float | None:
    if speed_mps is None or speed_mps <= 0:
        return None
    return _round_float(1000 / speed_mps, 1)


def _difference(later: Any, earlier: Any) -> float | None:
    if later is None or earlier is None:
        return None
    return _round_float(float(later) - float(earlier), 2)


def _ratio(value: float | None, baseline: float | None) -> float | None:
    if value is None or baseline is None or baseline == 0:
        return None
    return _round_float(value / baseline * 100, 2)


def _drop_none(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value is not None}


def _length_to_m(value: float | None) -> float | None:
    """FIT SDKs may decode step/stride length as metres or millimetres."""
    if value is None:
        return None
    return _round_float(value / 1000 if value > 10 else value, 3)
