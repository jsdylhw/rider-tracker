from __future__ import annotations

from domain.analysis.artifacts import (
    SUMMARY_SCHEMA_V2,
    build_history_view,
    get_analysis_summary,
    get_tss,
    summary_schema_version,
)


def test_only_v2_summary_is_recognized():
    assert summary_schema_version({"schema_version": SUMMARY_SCHEMA_V2}) == SUMMARY_SCHEMA_V2
    assert summary_schema_version({"schema_version": "llm_fit_file_analysis.v1"}) == "unknown"
    assert summary_schema_version({"history_entry": {}}) == "unknown"


def test_v2_summary_keeps_qualitative_and_numeric_load_fields_separate():
    document = {
        "schema_version": SUMMARY_SCHEMA_V2,
        "fit_summary": {
            "sport_type": "cycling",
            "duration_s": 1200,
            "distance_m": 9000,
            "start_time_local": "2026-08-13T08:00:00",
        },
        "analysis_summary": {
            "schema_version": "activity_analysis_summary.v1",
            "summary_label": "短途恢复骑",
            "load_label": "低总量，有氧维持",
        },
        "activity_metrics": {
            "schema_version": "activity_metrics.v2",
            "load": {"power_stress": {"tss": 14.5, "source": "fit_session"}},
        },
    }

    assert get_analysis_summary(document)["load_label"] == "低总量，有氧维持"
    assert get_tss(document["activity_metrics"]) == 14.5
    history = build_history_view(document)
    assert history["kind"] == "activity_report_history"
    assert history["duration_min"] == 20.0
    assert history["distance_km"] == 9.0
    assert "training_load" not in history
