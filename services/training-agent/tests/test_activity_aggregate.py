from __future__ import annotations

from operations.activity.aggregate import aggregate_summaries
from operations.activity.workflow_executor import execute_activity_run
from operations.activity.workflow_factory import TASK_AGGREGATE_REPORT, TASK_ENSURE_SUMMARY, create_activity_run_from_activities


def _store_summary(root, *, activity_key, distance_m, duration_s):
    return store_report(root, {
        "activity_key": activity_key,
        "fit_summary": {"sport_type": "cycling", "distance_m": distance_m, "duration_s": duration_s},
        "analysis_summary": {"summary_label": f"{activity_key} label", "main_stimulus": "aerobic"},
    })


def test_aggregate_summaries_is_deterministic_and_reports_omissions(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    first = _store_summary(tmp_path, activity_key="a1", distance_m=12345, duration_s=3660)

    result = aggregate_summaries([
        first,
        {"activity_key": "a2"},
    ])

    assert result["status"] == "partial"
    assert result["included_count"] == 1
    assert result["omitted"] == [{"activity_key": "a2", "reason": "report_unavailable"}]
    assert result["totals"] == {"distance_km": 12.35, "duration_min": 61.0}


def test_aggregate_task_runs_after_existing_summaries_without_confirmation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    activity = _store_summary(tmp_path, activity_key="a1", distance_m=5000, duration_s=1800)
    created = create_activity_run_from_activities(
        [activity],
        request={"source": "test", "goals": [TASK_ENSURE_SUMMARY, TASK_AGGREGATE_REPORT], "force": False},
        directory=tmp_path,
    )
    run = created["run"]

    result = execute_activity_run(run, directory=tmp_path)

    assert result["workflow"]["status"] == "completed"
    by_kind = {task["kind"]: task for task in run["tasks"]}
    assert by_kind[TASK_ENSURE_SUMMARY]["status"] == "skipped"
    assert by_kind[TASK_AGGREGATE_REPORT]["status"] == "completed"
    assert by_kind[TASK_AGGREGATE_REPORT]["report"]["totals"]["distance_km"] == 5.0
from tests.report_store_helpers import store_report
