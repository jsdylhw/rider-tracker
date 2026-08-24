from __future__ import annotations

from domain.analysis.models import AnalysisRequest
from services.activity.analysis import analyze_resolved_target, discover_activity_segments
from storage.repositories.activity import ActivityStore


def _store_facts_only_activity(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    store = ActivityStore()
    activity_id = "facts-only"
    store.upsert_activity({
        "activity_key": activity_id,
        "fit_path": str(tmp_path / "missing-but-not-needed.fit"),
        "sport_type": "cycling",
        "start_time_local": "2026-05-18T08:00:00",
        "duration_min": 30,
        "distance_km": 12,
    })
    store.save_facts(activity_id, metrics={
        "schema_version": "activity_metrics.v2",
        "activity_key": activity_id,
        "identity": {"sport_type": "cycling", "start_time_local": "2026-05-18T08:00:00"},
        "scale": {"duration_min": 30, "distance_km": 12},
        "power": {"normalized_power_w": 200, "intensity_factor": 0.8},
        "load": {"power_stress": {"tss": 30, "source": "fit_session"}},
    }, features={
        "schema_version": "activity_features.v1",
        "extractor_version": "test",
        "sprint_candidates": {
            "available": True,
            "count": 1,
            "segments": [{"type": "sprint", "start_s": 60, "end_s": 70, "duration_s": 11, "avg_power_w": 500, "max_power_w": 700}],
        },
        "effort_candidates": {"available": True, "summary": {}, "efforts": []},
        "climb_candidates": {"available": True, "count": 0, "segments": []},
    })
    return activity_id


def test_inspect_selection_uses_imported_facts_without_opening_fit(tmp_path, monkeypatch):
    activity_id = _store_facts_only_activity(tmp_path, monkeypatch)
    request = AnalysisRequest.from_arguments({"objective": "inspect_activity", "depth": "inspect"})

    result = analyze_resolved_target(request, activity_ids=[activity_id], segments_raw=[])

    assert result["analysis"]["source"] == "activity_facts"
    assert result["analysis"]["metrics"]["power"]["normalized_power_w"] == 200


def test_segment_discovery_uses_stored_candidates_without_opening_fit(tmp_path, monkeypatch):
    activity_id = _store_facts_only_activity(tmp_path, monkeypatch)

    result = discover_activity_segments(activity_id, {"segment_type": "sprint"})

    assert result["count"] == 1
    assert result["segments"][0]["start_seconds"] == 60.0
    assert result["segments"][0]["avg_power_w"] == 500
