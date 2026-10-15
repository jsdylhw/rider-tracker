"""Heart-rate-based stair set candidates; never infer per-set height or repetitions."""
from __future__ import annotations

import math
import numpy as np
import pandas as pd

from fit.parser import records_dataframe

DETECTOR = "stair_hr_cycles.v1"


def is_stair_climbing(parsed):
    return str((parsed.get("summary") or {}).get("sport_type") or "").lower() == "floor_climbing"


def stair_summary(parsed):
    session = (parsed.get("sessions") or [{}])[-1]
    duration = session.get("total_timer_time")
    ascent = session.get("total_ascent")
    zones = next((z for z in (parsed.get("training_metadata") or {}).get("time_in_zone", [])
                  if z.get("reference_mesg") in ("session", 18)), {})
    times = zones.get("time_in_hr_zone") or []
    boundaries = zones.get("hr_zone_high_boundary") or []
    total = sum(t for t in times if isinstance(t, (int, float)) and math.isfinite(t) and t >= 0)
    zone_rows = []
    valid_boundaries = (bool(boundaries) and all(isinstance(b, (int, float)) and math.isfinite(b) for b in boundaries)
                        and all(a < b for a, b in zip(boundaries, boundaries[1:])))
    for index, seconds in enumerate(times):
        if not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds <= 0:
            continue
        label = "边界未知"
        if valid_boundaries and index <= len(boundaries):
            if index == 0:
                label = f"{boundaries[0]:g} bpm 以下"
            elif index == len(boundaries):
                label = f"{boundaries[-1]:g} bpm 以上"
            else:
                label = f"{boundaries[index-1]:g}–{boundaries[index]:g} bpm"
        zone_rows.append({"range_label": label, "duration_s": seconds,
                          "percentage": round(seconds / total * 100, 1) if total else None})
    return {
        "analysis_basis_version": "stairs.v2",
        "duration_s": duration, "total_ascent_m": ascent,
        "total_descent_m": session.get("total_descent"),
        "whole_session_ascent_m_per_min": round(ascent * 60 / duration, 1)
            if isinstance(ascent, (int, float)) and isinstance(duration, (int, float)) and duration > 0 else None,
        "ascent_rate_basis": "whole_timer_including_recovery",
        "hr_zone_source": "fit_session" if zones else "unavailable",
        "hr_zone_method": zones.get("hr_calc_type"),
        "hr_zone_high_boundaries_bpm": boundaries,
        "hr_zone_seconds": times,
        "hr_zone_rows": zone_rows,
        "interpretation_limits": {
            "relative_load": "unavailable_without_comparable_history",
            "output_consistency": "unavailable_without_per_set_output",
            "recovery_adequacy": "not_established_by_heart_rate_drop",
        },
        "hr_zone_percentages": [round(t / total * 100, 1) if isinstance(t, (int, float)) and math.isfinite(t) and t >= 0 and total else None for t in times],
        "notes": ["累计爬升不等于逐点高度；不能均分到每组，也不换算实测楼层。"],
    }


def detect_stair_sets(parsed, *, max_segments=12):
    result = {"kind": "activity_scan", "detector": DETECTOR, "available": False,
              "baselines": {"sport_type": "floor_climbing", "scan_basis": "heart_rate"},
              "settings": {"smoothing_seconds": 15, "minimum_rise_bpm": 12,
                           "minimum_drop_bpm": 10, "minimum_rise_seconds": 30,
                           "rebound_bpm": 8,
                           "maximum_gap_seconds": 10},
              "notes": ["按心率估计做组与恢复，心率滞后使边界不同于实际动作起止。",
                        "电梯恢复属于场景约定，不是心率探测结论；不能据此判断恢复充分。"],
              "summary": {"effort_count": 0, "estimated_set_count": 0}, "efforts": [], "segments": []}
    if not is_stair_climbing(parsed):
        result["reason"] = "unsupported_sport"
        return result
    df = records_dataframe(parsed.get("records") or [])
    if df.empty or not {"elapsed_s", "heart_rate"}.issubset(df.columns):
        result["reason"] = "missing_heart_rate"
        return result
    df = df[["elapsed_s", "heart_rate"]].apply(pd.to_numeric, errors="coerce")
    df = df.replace([np.inf, -np.inf], np.nan).dropna()
    df = df[df.heart_rate.between(30, 240)].drop_duplicates("elapsed_s", keep="last").sort_values("elapsed_s")
    if len(df) < 2:
        result["reason"] = "insufficient_heart_rate"
        return result
    efforts = []
    blocks = list(df.groupby((df.elapsed_s.diff() > 10).cumsum()))
    for _, block in blocks:
        if block.elapsed_s.iloc[-1] - block.elapsed_s.iloc[0] < 30:
            continue
        ts = np.arange(math.ceil(block.elapsed_s.iloc[0]), math.floor(block.elapsed_s.iloc[-1]) + 1)
        raw = np.interp(ts, block.elapsed_s, block.heart_rate)
        hr = pd.Series(raw).rolling(15, center=True, min_periods=1).median().to_numpy()
        start = peak = trough = 0
        rising = True
        def emit(end, complete):
            if ts[peak] - ts[start] < 30 or hr[peak] - hr[start] < 12:
                return
            efforts.append({"type": "stair_set", "detector": DETECTOR, "estimated": True,
                            "start_s": float(ts[start]), "end_s": float(ts[peak]),
                            "duration_s": float(ts[peak] - ts[start]),
                            "avg_hr_bpm": round(float(np.mean(raw[start:peak])), 1),
                            "max_hr_bpm": round(float(np.max(raw[start:peak+1])), 1),
                            "smoothed_peak_hr_bpm": round(float(hr[peak]), 1),
                            "start_hr_bpm": round(float(hr[start]), 1),
                            "recovery_end_s": float(ts[end]),
                            "recovery_duration_s": float(ts[end] - ts[peak]),
                            "recovery_low_hr_bpm": round(float(hr[end]), 1),
                            "hr_drop_bpm": round(float(hr[peak] - hr[end]), 1),
                            "recovery_complete": complete,
                            "boundary": "observed_cycle" if complete else "recording_or_gap_boundary"})
        for i in range(1, len(ts)):
            if rising:
                if hr[i] < hr[start]:
                    start = peak = i
                if hr[i] >= hr[peak]:
                    peak = i
                if hr[peak] - hr[i] >= 10 and ts[peak] - ts[start] >= 30 and hr[peak] - hr[start] >= 12:
                    rising = False
                    trough = i
            else:
                if hr[i] <= hr[trough]:
                    trough = i
                if hr[i] - hr[trough] >= 8:
                    emit(trough, True)
                    start, peak, rising = trough, i, True
        emit(peak if rising else trough, False)
    result["available"] = True
    result["summary"] = {"effort_count": len(efforts), "estimated_set_count": len(efforts),
                         "gap_count": max(0, len(blocks)-1),
                         "returned_count": min(len(efforts), max(1, int(max_segments))),
                         "truncated": len(efforts) > max(1, int(max_segments))}
    result["efforts"] = efforts[:max(1, int(max_segments))]
    complete = [e for e in efforts if e["recovery_complete"]]
    result["summary"]["comparisons"] = {
        "all_set_peak_hr_range_bpm": [min(e["max_hr_bpm"] for e in efforts), max(e["max_hr_bpm"] for e in efforts)] if efforts else None,
        "complete_recovery_duration_range_s": [min(e["recovery_duration_s"] for e in complete), max(e["recovery_duration_s"] for e in complete)] if complete else None,
        "complete_recovery_count": len(complete),
        "incomplete_recovery_count": len(efforts) - len(complete),
    }
    result["stair_summary"] = stair_summary(parsed)
    return result
