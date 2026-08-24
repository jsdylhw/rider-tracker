from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

from agent.analysis.agent import analyze_fit_file
from fit.analysis.metrics import build_activity_metrics


def test_build_activity_metrics_exposes_machine_readable_cycling_load(sample_parsed_fit):
    result = build_activity_metrics(
        sample_parsed_fit,
        activity_key="activity-1",
        fit_path="rides/activity-1.fit",
    )

    assert result["schema_version"] == "activity_metrics.v2"
    assert result["activity_key"] == "activity-1"
    assert result["identity"]["sport_type"] == "cycling"
    assert result["scale"]["duration_min"] == 10.0
    assert result["scale"]["distance_km"] == 5.0
    assert result["power"]["normalized_power_w"] == 195.0
    assert result["power"]["intensity_factor"] == 0.75
    assert result["load"] == {
        "power_stress": {
            "available": True,
            "method": "cycling_power_tss",
            "tss": 45.0,
            "source": "fit_session",
        },
        "garmin": {
            "training_load_peak": 120.0,
            "training_load_peak_source": "fit_session",
            "aerobic_training_effect": 3.2,
            "anaerobic_training_effect": 0.5,
            "source": "fit_session",
        },
    }
    assert result["cadence"]["unit"] == "rpm"
    assert result["cadence"]["avg"] == 88.0
    assert result["performance"]["pace_available"] is False
    assert result["performance"]["avg_pace_s_per_km"] is None
    assert result["data_quality"]["has_power"] is True


def test_build_activity_metrics_does_not_apply_cycling_load_to_running(sample_parsed_fit):
    parsed = deepcopy(sample_parsed_fit)
    parsed["summary"]["sport_type"] = "running"
    parsed["sessions"][0]["sport"] = "running"
    parsed["training_metadata"]["zones_target"]["functional_threshold_power"] = 397

    result = build_activity_metrics(parsed)

    assert result["identity"]["sport_type"] == "running"
    assert result["power"]["intensity_factor"] is None
    assert result["load"]["power_stress"]["tss"] is None
    assert result["load"]["power_stress"]["method"] == "unavailable"
    assert result["cadence"]["unit"] == "spm"
    assert result["cadence"]["avg"] == 176.0
    assert result["performance"]["pace_available"] is True


def test_analyze_fit_file_persists_activity_metrics_json(sample_parsed_fit, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    fit_path = tmp_path / "ride.fit"
    fit_path.write_bytes(b"fit")
    monkeypatch.setattr("agent.analysis.agent.parse_fit", lambda path: sample_parsed_fit)
    monkeypatch.setattr(
        "agent.analysis.agent.analyze_with_llm",
        lambda path, parsed, history_before, user_request, facts=None, fit_summary=None: {
            "model": "test-model",
            "markdown_report": "# report",
            "strava_summary": "summary",
            "analysis_summary": {},
        },
    )

    result = analyze_fit_file(fit_path, force=True, persist=True)

    from storage.repositories.activity import ActivityStore

    saved = ActivityStore().get_report(result["activity_key"])
    assert saved["schema_version"] == "llm_fit_file_analysis.v2"
    assert "analysis_summary" in saved
    assert "history_before" not in saved
    assert saved["activity_metrics"]["load"]["power_stress"]["tss"] == 45.0
    assert saved["activity_metrics"]["load"]["garmin"]["training_load_peak"] == 120.0
    assert saved["activity_metrics"]["power"]["normalized_power_w"] == 195.0
    assert saved["activity_metrics"]["power"]["intensity_factor"] == 0.75
    facts = ActivityStore().get_facts(result["activity_key"])
    assert facts["metrics"]["schema_version"] == "activity_metrics.v2"
    assert facts["features"]["schema_version"] == "activity_features.v1"
