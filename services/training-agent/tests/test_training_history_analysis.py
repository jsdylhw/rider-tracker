from __future__ import annotations

from datetime import date

from agent.main_agent.context import AgentContext
from agent.tools.handlers.activity_insights import analyze_training_history_tool
from services.activity.training_history_analysis import analyze_training_history
from tests.test_history_metrics import _metrics, _store_metrics


def _history_activities(root):
    values = [
        _metrics(
            key="a1", start="2026-05-04T08:00:00", duration_min=50, distance_km=20,
            tss=35, avg_power_w=160, normalized_power_w=180, intensity_factor=.72, avg_hr_bpm=140,
        ),
        _metrics(
            key="a2", start="2026-05-06T08:00:00", duration_min=70, distance_km=30,
            tss=45, avg_power_w=170, normalized_power_w=190, intensity_factor=.76, avg_hr_bpm=145,
        ),
        _metrics(
            key="a3", start="2026-05-11T08:00:00", duration_min=60, distance_km=25,
            tss=40, avg_power_w=165, normalized_power_w=185, intensity_factor=.74, avg_hr_bpm=143,
        ),
        _metrics(
            key="a4", start="2026-05-13T08:00:00", duration_min=90, distance_km=40,
            tss=70, avg_power_w=180, normalized_power_w=205, intensity_factor=.82, avg_hr_bpm=150,
        ),
    ]
    return [_store_metrics(root, value) for value in values]


def test_professional_history_analysis_returns_stable_ui_contract(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    context = AgentContext(
        session_id="professional-history",
        selected_activities=_history_activities(tmp_path),
        selected_activity_range={"kind": "range", "start_date": "2026-05-04", "end_date": "2026-05-13"},
    )

    output = analyze_training_history_tool(context, group_by="week", sport_type="cycling")

    assert output["status"] == "completed"
    result = output["result"]
    assert result["schema_version"] == "training_history_analysis.v1"
    assert result["scope"]["sport_type"] == "cycling"
    assert result["scope"]["baseline_period"]["label"] == "2026-W19"
    assert result["scope"]["current_period"]["label"] == "2026-W20"
    assert result["scope"]["current_period"]["status"] == "closed"
    assert result["coverage"]["activity_count"] == 4
    assert result["coverage"]["comparable_session_count"] == 0
    assert result["conclusion"]["assessment"] == "mixed"
    assert result["conclusion"]["confidence"] == "low"
    assert {item["name"] for item in result["dimensions"]} == {
        "volume", "intensity", "consistency", "performance", "efficiency", "recovery",
    }
    assert next(item for item in result["dimensions"] if item["name"] == "performance")["direction"] == "unavailable"
    assert result["view"]["type"] == "training_history"
    assert len(result["series"]["periods"]) == 2


def test_professional_history_analysis_rejects_implicit_mixed_sport_comparison():
    output = analyze_training_history([
        {"activity_key": "ride", "sport_type": "cycling"},
        {"activity_key": "run", "sport_type": "running"},
    ])

    assert output["error"] == "mixed_sports_require_filter"


def test_professional_history_analysis_reports_insufficient_periods(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    activities = _history_activities(tmp_path)[:2]

    output = analyze_training_history(activities, group_by="week", sport_type="cycling")

    result = output["result"]
    assert result["conclusion"]["assessment"] == "insufficient_data"
    assert result["scope"]["baseline_period"] is None
    assert all(item["confidence"] == "low" for item in result["dimensions"])


def test_history_analysis_marks_latest_observed_bucket_closed_by_calendar_date(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    output = analyze_training_history(
        _history_activities(tmp_path),
        group_by="week",
        sport_type="cycling",
        today=date(2026, 5, 21),
    )

    result = output["result"]
    current = result["scope"]["current_period"]
    assert current == {
        "label": "2026-W20",
        "start": "2026-05-11",
        "end": "2026-05-17",
        "status": "closed",
        "as_of": "2026-05-21",
        "activity_count": 2,
        "active_days": 2,
    }
    assert any("不得将它描述为" in warning for warning in result["warnings"])
