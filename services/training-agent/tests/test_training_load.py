from __future__ import annotations

from agent.main_agent.context import AgentContext
from agent.tools.handlers.activity_insights import summarize_recent_training_load_tool
from tests.report_store_helpers import store_report


def _write_summary(path, *, key: str, tss: float, intensity_factor: float, distance_km: float, duration_min: float):
    return store_report(path, {
                "schema_version": "llm_fit_file_analysis.v2",
                "activity_key": key,
                "activity_metrics": {
                    "schema_version": "activity_metrics.v2",
                    "activity_key": key,
                    "identity": {
                        "sport_type": "cycling",
                        "start_time_local": f"2026-05-1{1 if key == 'a1' else 2}T08:00:00",
                    },
                    "scale": {"duration_min": duration_min, "distance_km": distance_km},
                    "power": {"intensity_factor": intensity_factor},
                    "load": {
                        "power_stress": {
                            "available": True,
                            "method": "cycling_power_tss",
                            "tss": tss,
                            "source": "fit_session",
                        },
                        "garmin": {"source": "unavailable"},
                    },
                },
                "fit_summary": {
                    "sport_type": "cycling",
                    "start_time_local": f"2026-05-1{1 if key == 'a1' else 2}T08:00:00",
                },
                "analysis_summary": {
                    "schema_version": "activity_analysis_summary.v1",
                    "summary_label": f"活动 {key}",
                    "main_stimulus": "耐力骑行",
                    "load_label": "低负荷" if tss < 50 else "高负荷",
                    "brief": f"NP 210W, IF {intensity_factor}, TSS {tss}",
                },
            })


def test_summarize_recent_training_load_outputs_structured_metrics_only(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    first = _write_summary(tmp_path, key="a1", tss=42.5, intensity_factor=0.62, distance_km=30, duration_min=80)
    second = _write_summary(tmp_path, key="a2", tss=114.0, intensity_factor=0.88, distance_km=43.2, duration_min=111.3)
    context = AgentContext(
        session_id="training-load-test",
        selected_activities=[
            first,
            second,
        ],
        selected_activity_range={"type": "recent_activities", "limit": 2},
    )

    result = summarize_recent_training_load_tool(context)

    assert result["status"] == "completed"
    assert "answer" not in result
    summary = result["result"]
    assert summary["kind"] == "training_load_summary"
    assert summary["activity_count"] == 2
    assert summary["totals"]["distance_km"] == 73.2
    assert summary["totals"]["duration_min"] == 191.3
    assert summary["totals"]["tss"] == 156.5
    assert summary["intensity"]["basis"] == "power_tss_if"
    assert summary["intensity"]["hard_activity_count"] == 1
    assert summary["intensity"]["easy_activity_count"] == 1
    assert summary["intensity"]["avg_if"] == 0.75
    assert "load_assessment" not in summary


def test_summarize_recent_training_load_reports_missing_metrics():
    context = AgentContext(
        session_id="training-load-test",
        selected_activities=[{"activity_key": "a1"}],
    )

    result = summarize_recent_training_load_tool(context)

    assert result["error"] == "missing_activity_metrics"
    assert result["missing"][0]["activity_key"] == "a1"


def test_structured_metrics_take_precedence_over_conflicting_report_text(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    activity = _write_summary(
        tmp_path,
        key="a1",
        tss=18.8,
        intensity_factor=0.75,
        distance_km=30,
        duration_min=60,
    )
    context = AgentContext(
        session_id="structured-load",
        selected_activities=[activity],
    )

    result = summarize_recent_training_load_tool(context)["result"]

    assert result["totals"] == {"distance_km": 30.0, "duration_min": 60.0, "tss": 18.8}
    assert result["intensity"]["avg_if"] == 0.75
    assert result["intensity"]["source_counts"] == {"stored_report_v2": 1}
