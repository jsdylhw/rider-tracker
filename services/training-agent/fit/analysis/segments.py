"""活动时序扫描:发现连续骑行高功率或跑步快速配速区间.

这个模块只做本地确定性扫描,不生成报告,不调用 LLM.它把 FIT records
转换成简短结构化区间,供后续分析/报告/对话层消费.
"""

from __future__ import annotations

from typing import Any

from fit.parser import records_dataframe

from fit.analysis.stats import _round_float, prune_empty_values

from .profiles import canonical_sport, is_running


def scan_activity_segments(
    parsed: dict[str, Any],
    *,
    window_seconds: int = 30,
    step_seconds: int = 10,
    max_segments: int = 12,
) -> dict[str, Any]:
    """全程扫描活动数据，按 sport_type 选择功率或配速基线。"""
    df = records_dataframe(parsed.get("records", []))
    if df.empty or "elapsed_s" not in df.columns:
        return {
            "kind": "activity_scan",
            "available": False,
            "reason": "No records or elapsed_s data available.",
        }

    df = _normalize_scan_columns(df)
    if df.empty:
        return {
            "kind": "activity_scan",
            "available": False,
            "reason": "No usable scan columns available.",
        }

    window_seconds = _clamp_int(window_seconds, 10, 180, default=30)
    step_seconds = _clamp_int(step_seconds, 5, window_seconds, default=10)
    baselines = _build_baselines(parsed, df)
    # 先用滑动窗口找到满足运动专项阈值的局部输出，再合并相邻窗口。
    windows = _scan_windows(df, window_seconds=window_seconds, step_seconds=step_seconds, baselines=baselines)
    detected = _merge_windows(df, windows, baselines=baselines)
    efforts = _finalize_efforts(detected, max_items=max(1, int(max_segments)), baselines=baselines)
    segments = _climb_segments_from_efforts(efforts)
    quality = _build_data_quality(parsed, df, baselines=baselines)

    return prune_empty_values({
        "kind": "activity_scan",
        "available": True,
        "settings": {
            "window_seconds": window_seconds,
            "step_seconds": step_seconds,
            "max_segments": max_segments,
        },
        "baselines": baselines,
        "summary": _build_summary(df, windows, segments, efforts, quality),
        "notes": quality.get("notes"),
        "segments": [
            {**segment, "index": index}
            for index, segment in enumerate(segments)
        ],
        "efforts": [
            {**effort, "index": index}
            for index, effort in enumerate(efforts)
        ],
    })


def _normalize_scan_columns(df: Any) -> Any:
    working = df.copy()
    if "enhanced_speed" not in working.columns and "speed" in working.columns:
        working["enhanced_speed"] = working["speed"]
    if "enhanced_altitude" not in working.columns and "altitude" in working.columns:
        working["enhanced_altitude"] = working["altitude"]
    if "distance" not in working.columns and "enhanced_speed" in working.columns:
        working["distance"] = working["enhanced_speed"].fillna(0).cumsum()
    return working


def _build_baselines(parsed: dict[str, Any], df: Any) -> dict[str, Any]:
    metadata = parsed.get("training_metadata") if isinstance(parsed.get("training_metadata"), dict) else {}
    zones = metadata.get("zones_target") if isinstance(metadata.get("zones_target"), dict) else {}
    sessions = parsed.get("sessions") if isinstance(parsed.get("sessions"), list) else []
    session = sessions[-1] if sessions and isinstance(sessions[-1], dict) else {}
    summary = parsed.get("summary") if isinstance(parsed.get("summary"), dict) else {}
    sport_type = canonical_sport(summary.get("sport_type") or session.get("sport"))
    running = is_running(sport_type)

    # 跑步 FIT 内的 FTP 往往是设备保留的骑行设定；跑步扫描只以配速定位。
    ftp = _first_number(
        zones.get("functional_threshold_power"),
        session.get("threshold_power"),
    ) if not running else None
    power = _numeric_series(df, "power")
    nonzero_power = power[power > 0] if power is not None else None
    p50 = _quantile(nonzero_power, 0.50)
    p70 = _quantile(nonzero_power, 0.70)
    p90 = _quantile(nonzero_power, 0.90)
    speed = _numeric_series(df, "enhanced_speed")
    nonzero_speed = speed[speed > 0] if speed is not None else None
    speed_p50 = _quantile(nonzero_speed, 0.50)
    speed_p70 = _quantile(nonzero_speed, 0.70)
    speed_p90 = _quantile(nonzero_speed, 0.90)
    # 高功率阈值取 FTP 的 95% 和本次非零功率 P70 中更高者;没有 FTP 时退化到本次分位数。
    if running:
        high_power = None
        tempo_power = None
    else:
        high_power = max(_none_to_zero(_multiply(ftp, 0.95)), _none_to_zero(p70)) or None
        tempo_power = max(_none_to_zero(_multiply(ftp, 0.60)), _none_to_zero(p50)) or None
    threshold_hr, threshold_hr_source = _resolve_threshold_hr(parsed)

    return prune_empty_values({
        "sport_type": sport_type,
        "scan_basis": "pace" if running else "power",
        "ftp_w": _round_float(ftp, 1),
        "threshold_hr_bpm": _round_float(threshold_hr, 1),
        "threshold_hr_source": threshold_hr_source,
        "max_hr_bpm": _round_float(_first_number(zones.get("max_heart_rate"), session.get("max_heart_rate")), 1),
        "resting_hr_bpm": _round_float(_first_number(zones.get("resting_heart_rate"), session.get("resting_heart_rate")), 1),
        "nonzero_power_p50_w": _round_float(p50, 1),
        "nonzero_power_p70_w": _round_float(p70, 1),
        "nonzero_power_p90_w": _round_float(p90, 1),
        "tempo_power_w": _round_float(tempo_power, 1),
        "high_power_w": _round_float(high_power, 1),
        "effort_power_w": _round_float(high_power, 1),
        "nonzero_speed_p50_mps": _round_float(speed_p50, 3),
        "nonzero_speed_p70_mps": _round_float(speed_p70, 3),
        "nonzero_speed_p90_mps": _round_float(speed_p90, 3),
        "effort_speed_mps": _round_float(speed_p70, 3),
    })


def _scan_windows(
    df: Any,
    *,
    window_seconds: int,
    step_seconds: int,
    baselines: dict[str, Any],
) -> list[dict[str, Any]]:
    max_elapsed = float(df["elapsed_s"].max())
    windows: list[dict[str, Any]] = []
    start = 0.0
    while start <= max_elapsed:
        end = start + window_seconds
        group = df[(df["elapsed_s"] >= start) & (df["elapsed_s"] < end)]
        if len(group) >= 3:
            features = _features_for_group(group, start_s=start, end_s=end)
            classification = _classify_window(features, baselines)
            if classification:
                windows.append({**features, **classification})
        start += step_seconds
    return windows


def _features_for_group(group: Any, *, start_s: float, end_s: float) -> dict[str, Any]:
    start_distance = _first_value(group, "distance")
    end_distance = _last_value(group, "distance")
    distance_m = _delta(start_distance, end_distance)
    altitude_start = _first_value(group, "enhanced_altitude")
    altitude_end = _last_value(group, "enhanced_altitude")
    elevation_delta = _delta(altitude_start, altitude_end)
    elevation_gain = _positive_altitude_change(group)
    elevation_loss = _negative_altitude_change(group)
    avg_grade = (
        elevation_delta / distance_m * 100
        if elevation_delta is not None and distance_m is not None and abs(distance_m) > 1
        else None
    )
    hr_start = _first_value(group, "heart_rate")
    hr_end = _last_value(group, "heart_rate")
    power = _numeric_series(group, "power")
    cadence = _numeric_series(group, "cadence")

    return prune_empty_values({
        "start_s": _round_float(start_s, 1),
        "end_s": _round_float(end_s, 1),
        "duration_s": _round_float(end_s - start_s, 1),
        "start_distance_m": _round_float(start_distance, 1),
        "end_distance_m": _round_float(end_distance, 1),
        "distance_m": _round_float(distance_m, 1),
        "elevation_delta_m": _round_float(elevation_delta, 1),
        "elevation_gain_m": _round_float(elevation_gain, 1),
        "elevation_loss_m": _round_float(elevation_loss, 1),
        "avg_grade_percent": _round_float(avg_grade, 2),
        "avg_power_w": _round_float(_mean(group, "power"), 1),
        "max_power_w": _round_float(_max(group, "power"), 1),
        "avg_hr_bpm": _round_float(_mean(group, "heart_rate"), 1),
        "max_hr_bpm": _round_float(_max(group, "heart_rate"), 1),
        "hr_rise_bpm": _round_float(_delta(hr_start, hr_end), 1),
        "avg_cadence_rpm": _round_float(_mean(group, "cadence"), 1),
        "avg_speed_mps": _round_float(_mean(group, "enhanced_speed"), 3),
        "avg_speed_kmh": _round_float(_mean(group, "enhanced_speed") * 3.6 if _mean(group, "enhanced_speed") is not None else None, 1),
        "avg_pace_s_per_km": _pace_seconds_per_km(_mean(group, "enhanced_speed")),
        "power_zero_fraction": _round_float(_zero_fraction(power), 3),
        "cadence_zero_fraction": _round_float(_zero_fraction(cadence), 3),
        "samples": int(len(group)),
    })


def _classify_window(features: dict[str, Any], baselines: dict[str, Any]) -> dict[str, Any] | None:
    if baselines.get("scan_basis") == "pace":
        avg_speed = _num(features.get("avg_speed_mps"))
        effort_speed = _num(baselines.get("effort_speed_mps"))
        if effort_speed is not None and avg_speed is not None and avg_speed >= effort_speed:
            p90 = _num(baselines.get("nonzero_speed_p90_mps")) or effort_speed
            score = min(avg_speed / p90 if p90 else 1.0, 1.0)
            return _classification("fast_running_segment", ["fast_pace"], score, ["pace_above_activity_p70"])
        return None

    avg_power = _num(features.get("avg_power_w"))
    effort_power = _num(baselines.get("effort_power_w"))
    if effort_power is not None and avg_power is not None and avg_power >= effort_power:
        ftp = _num(baselines.get("ftp_w"))
        ratio = (avg_power / ftp) if ftp else 1.0
        score = min(0.6 + max(0.0, ratio - 1.0) * 0.4, 1.0)
        return _classification("high_power_interval", ["high_power"], score, ["avg_power_above_effort_threshold"])
    return None


def _classification(segment_type: str, tags: list[str], score: float, reasons: list[str]) -> dict[str, Any]:
    return {
        "type": segment_type,
        "tags": tags,
        "reason_codes": reasons,
        "score": _round_float(min(score, 1.0), 3),
    }


def _merge_windows(df: Any, windows: list[dict[str, Any]], *, baselines: dict[str, Any]) -> list[dict[str, Any]]:
    if not windows:
        return []

    merged_ranges: list[dict[str, Any]] = []
    current = dict(windows[0])
    for window in windows[1:]:
        gap = float(window["start_s"]) - float(current["end_s"])
        # 相邻高功率窗口允许少量重叠/间隔,合并成一个更像训练区间的连续片段。
        if window["type"] == current["type"] and gap <= 15:
            current["end_s"] = max(float(current["end_s"]), float(window["end_s"]))
            current["score"] = max(float(current.get("score", 0)), float(window.get("score", 0)))
            current["tags"] = sorted(set(current.get("tags", [])) | set(window.get("tags", [])))
            current["reason_codes"] = sorted(set(current.get("reason_codes", [])) | set(window.get("reason_codes", [])))
        else:
            merged_ranges.append(current)
            current = dict(window)
    merged_ranges.append(current)

    segments = []
    for item in merged_ranges:
        group = df[(df["elapsed_s"] >= float(item["start_s"])) & (df["elapsed_s"] < float(item["end_s"]))]
        if len(group) < 3:
            continue
        features = _features_for_group(group, start_s=float(item["start_s"]), end_s=float(item["end_s"]))
        segments.append(prune_empty_values({
            "type": item["type"],
            "tags": item.get("tags", []),
            **features,
            "power_to_ftp": _power_ratio(features.get("avg_power_w"), baselines.get("ftp_w")),
            "reason_codes": item.get("reason_codes", []),
            "score": item.get("score"),
        }))
    return segments


def _finalize_efforts(
    detected: list[dict[str, Any]],
    *,
    max_items: int,
    baselines: dict[str, Any],
) -> list[dict[str, Any]]:
    efforts = []
    for item in detected:
        duration = _num(item.get("duration_s")) or 0
        if duration < 30:
            continue
        # 输出只保留给 LLM 判断区间意义所需的核心字段,避免把调试统计塞进上下文。
        effort = {
            "type": item.get("type") or "high_power_interval",
            "start_s": item.get("start_s"),
            "end_s": item.get("end_s"),
            "duration_s": item.get("duration_s"),
            "distance_m": item.get("distance_m"),
            "avg_power_w": item.get("avg_power_w"),
            "max_power_w": item.get("max_power_w"),
            "power_to_ftp": _power_ratio(item.get("avg_power_w"), baselines.get("ftp_w")),
            "avg_hr_bpm": item.get("avg_hr_bpm"),
            "max_hr_bpm": item.get("max_hr_bpm"),
            "avg_cadence_rpm": item.get("avg_cadence_rpm"),
            "avg_cadence_spm": (
                _round_float(_num(item.get("avg_cadence_rpm")) * 2, 1)
                if baselines.get("scan_basis") == "pace" and _num(item.get("avg_cadence_rpm")) is not None
                else None
            ),
            "avg_speed_kmh": item.get("avg_speed_kmh"),
            "avg_pace_s_per_km": item.get("avg_pace_s_per_km"),
            "elevation_gain_m": item.get("elevation_gain_m"),
            "avg_grade_percent": item.get("avg_grade_percent"),
            "score": item.get("score"),
        }
        climb = _climb_context(item)
        if climb.get("detected"):
            effort["climb"] = climb
        efforts.append(prune_empty_values(effort))
    return _rank_then_time_sort(efforts, max_items=max_items)


def _climb_segments_from_efforts(efforts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments = []
    for effort in efforts:
        climb = effort.get("climb")
        if not isinstance(climb, dict) or not climb.get("detected"):
            continue
        segments.append(prune_empty_values({
            "type": "climb",
            "start_s": effort.get("start_s"),
            "end_s": effort.get("end_s"),
            "duration_s": effort.get("duration_s"),
            "distance_m": effort.get("distance_m"),
            "elevation_gain_m": effort.get("elevation_gain_m"),
            "avg_grade_percent": effort.get("avg_grade_percent"),
            "avg_power_w": effort.get("avg_power_w"),
            "max_power_w": effort.get("max_power_w"),
            "power_to_ftp": effort.get("power_to_ftp"),
            "climb": climb,
        }))
    return segments


def _climb_context(item: dict[str, Any]) -> dict[str, Any]:
    gain = _num(item.get("elevation_gain_m")) or 0
    grade = _num(item.get("avg_grade_percent"))
    # 爬坡只是高功率区间的附加上下文;低于 30m 爬升不单独标记为爬坡。
    if gain < 30:
        return {"detected": False}
    climb_type = "long_climb"
    if grade is not None and grade >= 5:
        climb_type = "steep_climb"
    elif grade is not None and grade < 3:
        climb_type = "rolling_climb"
    return {
        "detected": True,
        "type": climb_type,
        "min_elevation_gain_m": 30,
    }


def _rank_then_time_sort(items: list[dict[str, Any]], *, max_items: int) -> list[dict[str, Any]]:
    ranked = sorted(items, key=lambda item: item.get("score", 0), reverse=True)[:max_items]
    return sorted(ranked, key=lambda item: item.get("start_s", 0))


def _build_summary(
    df: Any,
    windows: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    efforts: list[dict[str, Any]],
    quality: dict[str, Any],
) -> dict[str, Any]:
    segment_counts = _type_counts(segments)
    effort_counts = _type_counts(efforts)
    duration = _delta(_first_value(df, "elapsed_s"), _last_value(df, "elapsed_s"))
    distance = _delta(_first_value(df, "distance"), _last_value(df, "distance"))
    return prune_empty_values({
        "duration_s": _round_float(duration, 1),
        "distance_m": _round_float(distance, 1),
        "window_count": len(windows),
        "segment_count": len(segments),
        "effort_count": len(efforts),
        "key_effort_count": len(efforts),
        "climb_count": segment_counts.get("climb", 0),
        "segment_type_counts": segment_counts,
        "effort_type_counts": effort_counts,
        "data_quality_flags": quality.get("flags", []),
        "note_count": len(quality.get("notes", [])),
    })


def _type_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        counts[item["type"]] = counts.get(item["type"], 0) + 1
    return counts


def _build_data_quality(parsed: dict[str, Any], df: Any, *, baselines: dict[str, Any]) -> dict[str, Any]:
    flags = _data_quality_flags(df)
    notes: list[dict[str, Any]] = []
    sessions = parsed.get("sessions") if isinstance(parsed.get("sessions"), list) else []
    session = sessions[-1] if sessions and isinstance(sessions[-1], dict) else {}

    if baselines.get("scan_basis") == "power" and _num(baselines.get("ftp_w")) is None:
        notes.append({
            "code": "missing_ftp",
            "text": "未找到 FTP,高功率区间阈值会退化为本次活动内分位数。",
        })

    if _num(baselines.get("threshold_hr_bpm")) is None:
        notes.append({
            "code": "missing_threshold_hr",
            "text": "未找到阈值心率,心率强度只能按绝对心率粗略判断。",
        })

    record_duration = _delta(_first_value(df, "elapsed_s"), _last_value(df, "elapsed_s"))
    timer_duration = _first_number(session.get("total_timer_time"), parsed.get("summary", {}).get("duration_s"))
    elapsed_duration = _num(session.get("total_elapsed_time"))
    if record_duration and timer_duration and record_duration > timer_duration * 1.1:
        notes.append({
            "code": "record_span_exceeds_timer_time",
            "text": f"记录时间轴 {_round_float(record_duration / 60, 1)} 分钟长于运动计时 {_round_float(timer_duration / 60, 1)} 分钟,可能包含暂停或设备记录间隔。",
        })

    return prune_empty_values({
        "flags": flags,
        "notes": notes,
    })


def _resolve_threshold_hr(parsed: dict[str, Any]) -> tuple[float | None, str | None]:
    metadata = parsed.get("training_metadata") if isinstance(parsed.get("training_metadata"), dict) else {}
    zones = metadata.get("zones_target") if isinstance(metadata.get("zones_target"), dict) else {}
    sessions = parsed.get("sessions") if isinstance(parsed.get("sessions"), list) else []
    session = sessions[-1] if sessions and isinstance(sessions[-1], dict) else {}
    summary = parsed.get("summary") if isinstance(parsed.get("summary"), dict) else {}

    candidates = [
        ("session", session.get("threshold_heart_rate")),
        ("summary", summary.get("threshold_hr_bpm")),
        ("zones_target", zones.get("threshold_heart_rate")),
        ("time_in_zone", _threshold_hr_from_time_in_zone(metadata)),
    ]
    # Garmin 有些 FIT 会在主字段写 0,但 time_in_zone 里有有效阈值;这里直接跳过无效值。
    for source, value in candidates:
        number = _num(value)
        if number is not None and number > 0:
            return number, source
    return None, None


def _threshold_hr_from_time_in_zone(metadata: dict[str, Any]) -> float | None:
    entries = metadata.get("time_in_zone") if isinstance(metadata.get("time_in_zone"), list) else []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        threshold = _num(entry.get("threshold_heart_rate"))
        if threshold and threshold > 0:
            return threshold
    return None


def _data_quality_flags(df: Any) -> list[str]:
    flags = []
    for column in ["power", "heart_rate", "cadence", "enhanced_altitude", "distance"]:
        if column not in df.columns:
            flags.append(f"missing_{column}")
    return flags


def _numeric_series(df: Any, column: str) -> Any | None:
    if column not in df.columns:
        return None
    return df[column].dropna().astype(float)


def _mean(df: Any, column: str) -> float | None:
    series = _numeric_series(df, column)
    if series is None or series.empty:
        return None
    return float(series.mean())


def _max(df: Any, column: str) -> float | None:
    series = _numeric_series(df, column)
    if series is None or series.empty:
        return None
    return float(series.max())


def _quantile(series: Any, value: float) -> float | None:
    if series is None or series.empty:
        return None
    return float(series.quantile(value))


def _zero_fraction(series: Any | None) -> float | None:
    if series is None or series.empty:
        return None
    return float((series <= 0).sum() / len(series))


def _first_value(df: Any, column: str) -> float | None:
    series = _numeric_series(df, column)
    if series is None or series.empty:
        return None
    return float(series.iloc[0])


def _last_value(df: Any, column: str) -> float | None:
    series = _numeric_series(df, column)
    if series is None or series.empty:
        return None
    return float(series.iloc[-1])


def _delta(start: Any, end: Any) -> float | None:
    start_num = _num(start)
    end_num = _num(end)
    if start_num is None or end_num is None:
        return None
    return end_num - start_num


def _positive_altitude_change(group: Any) -> float | None:
    series = _numeric_series(group, "enhanced_altitude")
    if series is None or len(series) < 2:
        return None
    return float(series.diff().clip(lower=0).sum())


def _negative_altitude_change(group: Any) -> float | None:
    series = _numeric_series(group, "enhanced_altitude")
    if series is None or len(series) < 2:
        return None
    return float((-series.diff().clip(upper=0)).sum())


def _first_number(*values: Any) -> float | None:
    for value in values:
        number = _num(value)
        if number is not None:
            return number
    return None


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _pace_seconds_per_km(speed_mps: Any) -> float | None:
    speed = _num(speed_mps)
    if speed is None or speed <= 0:
        return None
    return _round_float(1000 / speed, 1)


def _multiply(value: Any, factor: float) -> float | None:
    number = _num(value)
    return number * factor if number is not None else None


def _none_to_zero(value: Any) -> float:
    number = _num(value)
    return number if number is not None else 0.0


def _power_ratio(power: Any, ftp: Any) -> float | None:
    power_num = _num(power)
    ftp_num = _num(ftp)
    if power_num is None or not ftp_num:
        return None
    return _round_float(power_num / ftp_num, 3)


def _clamp_int(value: Any, minimum: int, maximum: int, *, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))
