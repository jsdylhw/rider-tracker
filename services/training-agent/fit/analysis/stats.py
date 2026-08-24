"""纯数值计算和统计辅助函数,无项目内部依赖.

fit.analysis.data 中的工具实现通过这些函数完成单位转换,统计量提取,DataFrame 聚合等操作.
"""

from __future__ import annotations

from typing import Any


def _round_float(value: Any, digits: int = 3) -> float | None:
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


def _first_number(*values: Any) -> float | None:
    """从优先级递减的候选值中返回第一个有效数值."""
    for value in values:
        number = _round_float(value)
        if number is not None:
            return number
    return None


def _last_item(value: Any) -> dict[str, Any] | None:
    if isinstance(value, list) and value:
        item = value[-1]
        return item if isinstance(item, dict) else None
    return None


def _stats_value(stats: dict[str, dict[str, Any]], field: str, metric: str) -> Any:
    return (stats.get(field) or {}).get(metric)


def _seconds_to_minutes(value: Any) -> float | None:
    number = _round_float(value)
    if number is None:
        return None
    return _round_float(number / 60, 1)


def _meters_to_km(value: Any) -> float | None:
    number = _round_float(value)
    if number is None:
        return None
    return _round_float(number / 1000, 2)


def _mps_to_kmh(value: Any) -> float | None:
    number = _round_float(value)
    if number is None:
        return None
    return _round_float(number * 3.6, 1)


def _select_stats(stats: dict[str, dict[str, Any]], field: str) -> dict[str, Any]:
    """从 _numeric_field_stats 输出中提取常用统计量(count/min/max/avg/median/p25/p75)."""
    values = stats.get(field) or {}
    return {
        key: values.get(key)
        for key in ["count", "min", "max", "avg", "median", "p25", "p75"]
        if key in values
    }


def _numeric_field_stats(df: Any) -> dict[str, dict[str, Any]]:
    """对 DataFrame 每个数值列计算 count/min/max/avg/median/p25/p75."""
    if df.empty:
        return {}
    stats: dict[str, dict[str, Any]] = {}
    for column in df.columns:
        values = df[column]
        if not hasattr(values, "dropna"):
            continue
        try:
            numeric = values.dropna().astype(float)
        except (TypeError, ValueError):
            continue
        if numeric.empty:
            continue
        stats[str(column)] = {
            "count": int(numeric.count()),
            "min": _round_float(numeric.min()),
            "max": _round_float(numeric.max()),
            "avg": _round_float(numeric.mean()),
            "median": _round_float(numeric.median()),
            "p25": _round_float(numeric.quantile(0.25)),
            "p75": _round_float(numeric.quantile(0.75)),
        }
    return stats


def _rows_to_column_arrays(rows: list[dict[str, Any]]) -> dict[str, list[Any]]:
    """将 list[dict] 转为 column_arrays 格式 {key: [value, ...]}.

    column_arrays 比 list[dict] 省 token,且按固定顺序输出共有 key.
    """
    if not rows:
        return {}
    ordered_keys = [
        "start_s", "end_s", "start_d", "end_d", "duration_s", "samples",
        "distance_start_m", "distance_end_m", "distance_delta_m",
        "avg_hr_bpm", "max_hr_bpm",
        "avg_power_w", "avg_nonzero_power_w", "max_power_w",
        "power_w_zero_samples", "power_w_zero_fraction",
        "avg_cadence_rpm", "avg_nonzero_cadence_rpm", "max_cadence_rpm",
        "cadence_rpm_zero_samples", "cadence_rpm_zero_fraction",
        "avg_cadence_spm",
        "avg_speed_mps", "avg_nonzero_speed_mps", "max_speed_mps",
        "speed_mps_zero_samples", "speed_mps_zero_fraction",
        "avg_pace_s_per_km",
        "avg_altitude_m", "max_altitude_m",
    ]
    common_keys = set(rows[0])
    for row in rows[1:]:
        common_keys &= set(row)
    return {key: [row[key] for row in rows] for key in ordered_keys if key in common_keys}


def _normalize_bucket_seconds(value: int) -> int:
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return 60
    return max(1, min(seconds, 600))


ALLOWED_BUCKET_DISTANCE_M = [100, 200, 500, 1000, 3000, 5000, 10000]


def _normalize_bucket_distance_m(value: Any) -> int:
    try:
        distance = int(float(value))
    except (TypeError, ValueError):
        return 1000
    if distance in ALLOWED_BUCKET_DISTANCE_M:
        return distance
    return min(ALLOWED_BUCKET_DISTANCE_M, key=lambda candidate: abs(candidate - distance))


def _filter_numeric_window(df: Any, column: str, *, start: Any = None, end: Any = None) -> Any:
    """按数值列范围过滤 DataFrame 行,用于时间/距离窗口截取."""
    working = df.copy()
    try:
        values = working[column].astype(float)
    except (KeyError, TypeError, ValueError):
        return working.iloc[0:0]
    start_value = _round_float(start)
    end_value = _round_float(end)
    if start_value is not None:
        working = working[values >= start_value]
        values = working[column].astype(float)
    if end_value is not None:
        working = working[values <= end_value]
    return working.copy()


def _duration_from_group(group: Any) -> float | None:
    """分组时长 = elapsed_s 的 max - min.单条记录返回 0.0."""
    try:
        elapsed = group["elapsed_s"].dropna().astype(float)
    except (KeyError, TypeError, ValueError):
        return None
    if elapsed.empty:
        return None
    if len(elapsed) == 1:
        return 0.0
    return float(elapsed.max() - elapsed.min())


def _distance_delta(group: Any) -> dict[str, float | None]:
    if "distance" not in group.columns:
        return {}
    try:
        values = group["distance"].dropna().astype(float)
    except (TypeError, ValueError):
        return {}
    if values.empty:
        return {}
    return {
        "distance_start_m": _round_float(values.iloc[0], 1),
        "distance_end_m": _round_float(values.iloc[-1], 1),
        "distance_delta_m": _round_float(values.iloc[-1] - values.iloc[0], 1),
    }


def _series_stats(
    group: Any, column: str, prefix: str, *, include_zero_stats: bool = False,
) -> dict[str, float | int | None]:
    """分组的 avg/max.include_zero_stats=True 时额外输出非零均值和零值占比.

    0 值对功率/踏频/速度有训练含义(滑行,停踩,停车),所以可选保留零值统计.
    """
    if column not in group.columns:
        return {}
    try:
        values = group[column].dropna().astype(float)
    except (TypeError, ValueError):
        return {}
    if values.empty:
        return {}
    result: dict[str, float | int | None] = {
        f"avg_{prefix}": _round_float(values.mean(), 1),
        f"max_{prefix}": _round_float(values.max(), 1),
    }
    if include_zero_stats:
        # 功率/踏频=0 通常代表滑行或停踩,保留占比让 LLM 判断
        zero_count = int((values == 0).sum())
        nonzero_values = values[values != 0]
        result.update({
            f"avg_nonzero_{prefix}": _round_float(nonzero_values.mean(), 1) if not nonzero_values.empty else 0.0,
            f"{prefix}_zero_samples": zero_count,
            f"{prefix}_zero_fraction": _round_float(zero_count / len(values), 3),
        })
    return result


def prune_empty_values(value: Any) -> Any:
    """递归删除 dict/list 中的 None,空 dict,空 list,减少 LLM token 消耗."""
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            pruned = prune_empty_values(item)
            if _is_empty_value(pruned):
                continue
            cleaned[key] = pruned
        return cleaned
    if isinstance(value, list):
        cleaned_list = [prune_empty_values(item) for item in value]
        return [item for item in cleaned_list if not _is_empty_value(item)]
    return value


def _is_empty_value(value: Any) -> bool:
    return value is None or value == {} or value == []
