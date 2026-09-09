"""Sport-aware running analysis data and prompt tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from agent.analysis.prompts import build_fit_analysis_system_prompt
from fit.analysis.data import (
    get_activity_overview_tool,
    get_activity_summary_tool,
    get_distance_intervals_tool,
    get_running_efficiency_tool,
)
from fit.analysis.segments import scan_activity_segments
from domain.athlete import enrich_training_metadata


def _running_parsed() -> dict:
    start = datetime(2026, 7, 20, 6, 30, tzinfo=timezone.utc)
    records = []
    distance = 0.0
    for second in range(180):
        # 40-119 秒是稳定的加速跑段，其余为轻松跑。
        speed = 4.2 if 40 <= second < 120 else 3.2
        distance += speed
        records.append({
            "timestamp": (start + timedelta(seconds=second)).isoformat(),
            "distance": distance,
            "enhanced_speed": speed,
            "heart_rate": 155 if 40 <= second < 120 else 140,
            # FIT record cadence is running stride cycles/min; user-facing spm is twice it.
            "cadence": 92 if 40 <= second < 120 else 86,
            "enhanced_altitude": 12.0 + second * 0.03,
            "vertical_oscillation": 82.0,
            "stance_time": 245.0,
            "step_length": 1.12,
        })
    return {
        "path": "run.fit",
        "summary": {
            "sport_type": "running",
            "sub_sport": "road",
            "start_time_local": "2026-07-20T14:30:00",
            "duration_s": 180.0,
            "distance_m": distance,
        },
        "records": records,
        "sessions": [{
            "sport": "running",
            "sub_sport": "road",
            "total_timer_time": 180.0,
            "total_elapsed_time": 180.0,
            "total_distance": distance,
            "enhanced_avg_speed": 3.64,
            "enhanced_max_speed": 4.2,
            "avg_heart_rate": 147,
            "max_heart_rate": 160,
            "avg_cadence": 88.5,
            "max_cadence": 93,
        }],
        "laps": [],
        "training_metadata": {"zones_target": {}, "user_profile": {}},
    }


def test_running_summary_exposes_pace_spm_and_present_dynamics():
    result = get_activity_summary_tool(
        _running_parsed(), sections=["pace", "cadence", "running_dynamics"],
    )

    assert result["pace"]["summary"]["avg_pace_s_per_km"] == 274.7
    assert result["cadence"]["summary"]["unit"] == "spm"
    assert result["cadence"]["summary"]["avg_cadence_spm"] == 177.0
    assert result["running_dynamics"]["available"] is True
    assert "stance_time" in result["running_dynamics"]["record_fields"]
    assert result["running_dynamics"]["summary"]["stance_time_ms"] == 245.0
    assert result["running_dynamics"]["summary"]["step_length_m"] == 1.12


def test_running_segment_scan_uses_pace_baseline_not_power():
    result = scan_activity_segments(_running_parsed(), window_seconds=30, step_seconds=10)

    assert result["baselines"]["scan_basis"] == "pace"
    assert result["baselines"].get("high_power_w") is None
    assert any(item["type"] == "fast_running_segment" for item in result["efforts"])


def test_running_distance_intervals_include_pace_and_spm():
    result = get_distance_intervals_tool(_running_parsed(), bucket_distance_m=100)

    assert "avg_pace_s_per_km" in result["series"]
    assert "avg_cadence_spm" in result["series"]


def test_running_efficiency_compares_early_and_late_active_windows():
    result = get_running_efficiency_tool(_running_parsed())

    assert result["available"] is True
    assert result["comparison_basis"] == "first_last_active_30_percent"
    assert result["early"]["avg_pace_s_per_km"] < result["late"]["avg_pace_s_per_km"]
    assert result["change"]["pace_change_s_per_km"] > 0
    assert result["early"]["avg_cadence_spm"] is not None


def test_running_efficiency_rejects_non_running_activity():
    parsed = _running_parsed()
    parsed["summary"]["sport_type"] = "cycling"

    result = get_running_efficiency_tool(parsed)

    assert result == {
        "kind": "running_efficiency",
        "available": False,
        "reason": "running_efficiency is only applicable to running activities.",
    }


def test_running_prompt_includes_sport_specific_guidance():
    assert "Running analysis mode" in build_fit_analysis_system_prompt("running")
    assert "Running analysis mode" not in build_fit_analysis_system_prompt("cycling")


def test_running_ignores_fit_ftp_and_cycling_load_metrics():
    parsed = _running_parsed()
    parsed["sessions"][0].update({
        "normalized_power": 291,
        "threshold_power": 397,
        "intensity_factor": 0.733,
        "training_stress_score": 10.3,
    })
    parsed["training_metadata"]["zones_target"]["functional_threshold_power"] = 397

    summary = get_activity_summary_tool(parsed, sections=["power", "pace", "energy_load", "training_zones"])
    overview = get_activity_overview_tool(parsed)

    assert summary["power"]["summary"]["threshold_power_w"] is None
    assert summary["power"]["summary"]["threshold_power_source"] == "unavailable"
    assert summary["power"]["summary"]["intensity_factor"] is None
    assert summary["pace"]["summary"]["threshold_pace_source"] == "unavailable"
    assert summary["energy_load"]["tss"] is None
    assert "functional_threshold_power" not in summary["training_zones"]["zones_target"]
    assert overview["basic_metrics"]["intensity_factor"] is None
    assert overview["basic_metrics"]["tss"] is None


def test_running_power_ratio_requires_running_profile_threshold():
    parsed = _running_parsed()
    parsed["sessions"][0]["normalized_power"] = 291
    parsed["training_metadata"] = enrich_training_metadata(
        parsed["training_metadata"],
        {"cycling": {"ftp_w": 397}, "running": {"threshold_power_w": 300}},
        sport_type="running",
    )

    summary = get_activity_summary_tool(parsed, sections=["power"])

    assert summary["power"]["summary"]["threshold_power_w"] == 300.0
    assert summary["power"]["summary"]["threshold_power_source"] == "athlete_profile.running"
    assert summary["power"]["summary"]["running_power_intensity_ratio"] == 0.97


def test_running_pace_exposes_running_profile_and_fit_target_separately():
    parsed = _running_parsed()
    parsed["training_metadata"] = enrich_training_metadata(
        {"zones_target": {}, "time_in_zone": [], "user_profile": {}, "training_settings": {"target_speed": 3.0}},
        {"running": {"threshold_pace_s_per_km": 285, "critical_speed_mps": 3.6}},
        sport_type="running",
    )

    summary = get_activity_summary_tool(parsed, sections=["pace"])

    assert summary["pace"]["summary"] == {
        "avg_pace_s_per_km": 274.7,
        "fastest_pace_s_per_km": 238.1,
        "threshold_pace_s_per_km": 285.0,
        "threshold_pace_source": "athlete_profile.running",
        "critical_speed_mps": 3.6,
        "critical_speed_source": "athlete_profile.running",
        "target_pace_s_per_km": 333.3,
        "target_pace_source": "fit_training_settings",
    }
