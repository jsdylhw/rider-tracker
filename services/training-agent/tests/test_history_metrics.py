from __future__ import annotations

from agent.tools.handlers.activity_insights import calculate_history_metrics_tool
from agent.main_agent.context import AgentContext
from tests.report_store_helpers import store_report


def _metrics(
    *,
    key: str,
    start: str,
    duration_min: float,
    distance_km: float,
    tss: float,
    avg_power_w: float,
    normalized_power_w: float,
    intensity_factor: float,
    avg_hr_bpm: float,
) -> dict:
    return {
        "schema_version": "activity_metrics.v2",
        "activity_key": key,
        "identity": {"sport_type": "cycling", "start_time_local": start},
        "scale": {
            "duration_min": duration_min,
            "distance_km": distance_km,
            "total_ascent_m": 100,
        },
        "power": {
            "avg_power_w": avg_power_w,
            "max_power_w": avg_power_w * 2,
            "normalized_power_w": normalized_power_w,
            "threshold_power_w": 250,
            "intensity_factor": intensity_factor,
        },
        "heart_rate": {"avg_hr_bpm": avg_hr_bpm},
        "cadence": {"avg": 85},
        "performance": {"avg_speed_kmh": distance_km / (duration_min / 60), "max_speed_kmh": 40},
        "load": {
            "power_stress": {
                "available": True,
                "method": "cycling_power_tss",
                "tss": tss,
                "source": "fit_session",
            },
            "garmin": {"source": "unavailable"},
        },
    }


def _store_metrics(root, metrics: dict) -> dict:
    return store_report(root, {
            "schema_version": "llm_fit_file_analysis.v2",
            "activity_key": metrics["activity_key"],
            "activity_metrics": metrics,
        })


def test_history_metrics_groups_by_week_and_uses_weighted_averages(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    first = _metrics(
        key="a1", start="2026-05-04T08:00:00", duration_min=60, distance_km=20,
        tss=30, avg_power_w=100, normalized_power_w=120, intensity_factor=0.5, avg_hr_bpm=130,
    )
    second = _metrics(
        key="a2", start="2026-05-05T08:00:00", duration_min=120, distance_km=40,
        tss=70, avg_power_w=200, normalized_power_w=220, intensity_factor=0.8, avg_hr_bpm=150,
    )
    third = _metrics(
        key="a3", start="2026-05-11T08:00:00", duration_min=60, distance_km=30,
        tss=50, avg_power_w=180, normalized_power_w=195, intensity_factor=0.75, avg_hr_bpm=145,
    )
    activities = []
    for metrics in (first, second, third):
        activities.append(_store_metrics(tmp_path, metrics))
    context = AgentContext(
        session_id="history-metrics",
        selected_activities=activities,
        selected_activity_range={"type": "date_range", "start_date": "2026-05-04", "end_date": "2026-05-11"},
    )

    output = calculate_history_metrics_tool(context, group_by="week")

    assert output["status"] == "completed"
    result = output["result"]
    assert result["schema_version"] == "training_history_metrics.v1"
    assert result["coverage"]["source_counts"] == {"stored_report_v2": 3}
    assert result["coverage"]["metric_counts"]["tss"] == 3
    assert result["overall"]["totals"]["duration_min"] == 240.0
    assert result["overall"]["totals"]["distance_km"] == 90.0
    assert result["overall"]["totals"]["tss"] == 150.0
    assert [period["period"] for period in result["periods"]] == ["2026-W19", "2026-W20"]
    first_week = result["periods"][0]
    assert first_week["totals"]["tss"] == 100.0
    assert first_week["weighted_averages"]["avg_power_w"] == 166.67
    assert first_week["weighted_averages"]["intensity_factor"] == 0.7
    assert result["comparison"]["changes"]["tss"] == {
        "previous": 100.0,
        "current": 50.0,
        "absolute_change": -50.0,
        "percent_change": -50.0,
    }


def test_history_metrics_falls_back_to_fit_without_rewriting_old_summary(
    tmp_path, monkeypatch, sample_parsed_fit,
):
    fit_path = tmp_path / "legacy.fit"
    fit_path.write_bytes(b"fit")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("services.activity.history.parse_fit", lambda path: sample_parsed_fit)
    context = AgentContext(
        session_id="history-fallback",
        selected_activities=[{
            "activity_key": "legacy",
            "fit_path": str(fit_path),
        }],
    )

    output = calculate_history_metrics_tool(context)

    result = output["result"]
    assert result["coverage"]["source_counts"] == {"fit_fallback": 1}
    assert result["overall"]["totals"]["tss"] == 45.0
    assert result["overall"]["weighted_averages"]["intensity_factor"] == 0.75


def test_history_metrics_prefers_imported_facts_without_any_report(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    metrics = _metrics(
        key="facts-only", start="2026-05-14T08:00:00", duration_min=45, distance_km=20,
        tss=40, avg_power_w=180, normalized_power_w=200, intensity_factor=0.8, avg_hr_bpm=145,
    )
    from storage.repositories.activity import ActivityStore

    store = ActivityStore()
    store.upsert_activity({
        "activity_key": "facts-only",
        "fit_path": str(tmp_path / "facts-only.fit"),
        "sport_type": "cycling",
        "start_time_local": "2026-05-14T08:00:00",
        "duration_min": 45,
        "distance_km": 20,
    })
    store.save_facts(
        "facts-only",
        metrics=metrics,
        features={"schema_version": "activity_features.v1", "extractor_version": "test", "sprint_candidates": {}, "effort_candidates": {}, "climb_candidates": {}},
    )
    context = AgentContext(session_id="facts-history", selected_activities=[{"activity_key": "facts-only"}])

    output = calculate_history_metrics_tool(context)

    assert output["result"]["coverage"]["source_counts"] == {"stored_facts_v1": 1}
    assert output["result"]["overall"]["totals"]["tss"] == 40.0


def test_history_metrics_rejects_unknown_grouping():
    context = AgentContext(session_id="history", selected_activities=[{"activity_key": "a1"}])

    output = calculate_history_metrics_tool(context, group_by="quarter")

    assert output["error"] == "invalid_group_by"
