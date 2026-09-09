"""Deterministic, sport-aware metrics for one parsed FIT activity.

The LLM report is prose and may change wording between runs.  This module
creates the stable numeric contract used by history aggregation and other
downstream tools.
"""

from __future__ import annotations

from typing import Any

from domain.contracts.schemas import ACTIVITY_METRICS_V2
from fit.analysis.data import get_activity_overview_tool, get_activity_summary_tool
from fit.analysis.profiles import is_running


METRIC_SECTIONS = [
    "activity_identity",
    "duration_distance",
    "power",
    "heart_rate",
    "cadence",
    "speed",
    "pace",
    "elevation",
    "energy_load",
]


def build_activity_metrics(
    parsed: dict[str, Any],
    *,
    activity_key: str | None = None,
    fit_path: str | None = None,
) -> dict[str, Any]:
    """Build the ``activity_metrics.v2`` persistence contract.

    Values are calculated only from parsed FIT data and athlete thresholds.
    No LLM text is parsed or interpreted here.
    """
    overview = get_activity_overview_tool(parsed)
    detail = get_activity_summary_tool(parsed, sections=METRIC_SECTIONS)

    identity = _dict(detail.get("activity_identity"))
    scale = _dict(detail.get("duration_distance"))
    power_section = _dict(detail.get("power"))
    power = _dict(power_section.get("summary"))
    heart_rate_section = _dict(detail.get("heart_rate"))
    heart_rate = _dict(heart_rate_section.get("summary"))
    cadence_section = _dict(detail.get("cadence"))
    cadence = _dict(cadence_section.get("summary"))
    speed_section = _dict(detail.get("speed"))
    speed = _dict(speed_section.get("summary"))
    pace_section = _dict(detail.get("pace"))
    pace = _dict(pace_section.get("summary"))
    elevation_section = _dict(detail.get("elevation"))
    elevation = _dict(elevation_section.get("summary"))
    energy_load = _dict(detail.get("energy_load"))
    basic = _dict(overview.get("basic_metrics"))
    availability = _dict(overview.get("data_availability"))
    running = is_running(identity.get("sport_type"))

    session_tss = _number(energy_load.get("tss"))
    calculated_tss = _number(basic.get("tss"))
    tss = session_tss if session_tss is not None else calculated_tss
    if session_tss is not None:
        tss_source = "fit_session"
    elif calculated_tss is not None:
        tss_source = "estimated_from_np_ftp_duration"
    else:
        tss_source = "unavailable"

    cadence_unit = cadence.get("unit")
    avg_cadence = cadence.get("avg_cadence_spm") if cadence_unit == "spm" else cadence.get("avg_cadence_rpm")
    max_cadence = cadence.get("max_cadence_spm") if cadence_unit == "spm" else cadence.get("max_cadence_rpm")

    garmin_training_load = _number(energy_load.get("training_load_peak"))
    aerobic_training_effect = _number(energy_load.get("aerobic_training_effect"))
    anaerobic_training_effect = _number(energy_load.get("anaerobic_training_effect"))
    garmin_load_available = any(
        value is not None
        for value in (garmin_training_load, aerobic_training_effect, anaerobic_training_effect)
    )
    return {
        "schema_version": ACTIVITY_METRICS_V2,
        "activity_key": activity_key,
        "fit_path": fit_path or identity.get("source_file") or parsed.get("path"),
        "identity": {
            "sport_type": identity.get("sport_type"),
            "sub_sport": identity.get("sub_sport"),
            "start_time_local": identity.get("start_time_local"),
        },
        "scale": {
            **scale,
            "total_ascent_m": elevation.get("total_ascent_m"),
            "total_descent_m": elevation.get("total_descent_m"),
            "calories": energy_load.get("calories"),
        },
        "power": {
            "available": bool(power_section.get("available")),
            "avg_power_w": power.get("avg_power_w"),
            "max_power_w": power.get("max_power_w"),
            "normalized_power_w": power.get("normalized_power_w"),
            "threshold_power_w": power.get("threshold_power_w"),
            "threshold_power_source": power.get("threshold_power_source"),
            "intensity_factor": power.get("intensity_factor"),
            "running_power_intensity_ratio": power.get("running_power_intensity_ratio"),
            "variability_index": power.get("variability_index"),
            "total_work_kj": power.get("total_work_kj"),
        },
        "heart_rate": {
            "available": bool(heart_rate_section.get("available")),
            "avg_hr_bpm": heart_rate.get("avg_hr_bpm"),
            "max_hr_bpm": heart_rate.get("max_hr_bpm"),
            "resting_hr_bpm": heart_rate.get("resting_hr_bpm"),
            "max_hr_setting_bpm": heart_rate.get("max_hr_setting_bpm"),
            "threshold_hr_bpm": heart_rate.get("threshold_hr_bpm"),
        },
        "cadence": {
            "available": bool(cadence_section.get("available")),
            "unit": cadence_unit,
            "avg": avg_cadence,
            "max": max_cadence,
        },
        "performance": {
            "speed_available": bool(speed_section.get("available")),
            "avg_speed_kmh": speed.get("avg_speed_kmh"),
            "max_speed_kmh": speed.get("max_speed_kmh"),
            "pace_available": running and bool(pace_section.get("available")),
            "avg_pace_s_per_km": pace.get("avg_pace_s_per_km") if running else None,
            "fastest_pace_s_per_km": pace.get("fastest_pace_s_per_km") if running else None,
            "threshold_pace_s_per_km": pace.get("threshold_pace_s_per_km") if running else None,
            "threshold_pace_source": pace.get("threshold_pace_source") if running else "unsupported_sport",
        },
        "load": {
            "power_stress": {
                "available": tss is not None,
                "method": "cycling_power_tss" if tss is not None else "unavailable",
                "tss": tss,
                "source": tss_source,
            },
            "garmin": {
                "training_load_peak": garmin_training_load,
                "training_load_peak_source": "fit_session" if garmin_training_load is not None else "unavailable",
                "aerobic_training_effect": aerobic_training_effect,
                "anaerobic_training_effect": anaerobic_training_effect,
                "source": "fit_session" if garmin_load_available else "unavailable",
            },
        },
        "data_quality": {
            **availability,
            "power_record_count": power_section.get("record_count_with_data"),
            "heart_rate_record_count": heart_rate_section.get("record_count_with_data"),
            "cadence_record_count": cadence_section.get("record_count_with_data"),
        },
    }


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
