from __future__ import annotations

from operations.activity.workflow_factory import (
    TASK_AGGREGATE_REPORT,
    TASK_ENSURE_SUMMARY,
    TASK_UPLOAD_STRAVA,
    create_local_activity_run,
)
from storage.repositories.workflow import load_workflow


def _activities():
    return [
        {"activity_key": "a1", "fit_path": "a1.fit", "sport_type": "cycling"},
        {"activity_key": "a2", "fit_path": "a2.fit", "sport_type": "running"},
    ]


def test_local_factory_snapshots_targets_and_creates_dependencies(monkeypatch, tmp_path):
    source_activities = _activities()
    monkeypatch.setattr(
        "operations.activity.workflow_factory.resolve_recent",
        lambda **kwargs: {
            "status": "completed",
            "selection": {"kind": "recent", "limit": 2, "order": "latest", "sport_type": None},
            "activities": source_activities,
        },
    )

    result = create_local_activity_run(
        limit=2,
        goals=[TASK_UPLOAD_STRAVA, TASK_AGGREGATE_REPORT],
        directory=tmp_path,
    )

    assert result["status"] == "created"
    run = result["run"]
    assert run["request"]["source"] == "local"
    assert run["request"]["goals"] == [TASK_ENSURE_SUMMARY, TASK_UPLOAD_STRAVA, TASK_AGGREGATE_REPORT]
    assert len(run["activities"]) == 2
    by_id = {task["task_id"]: task for task in run["tasks"]}
    assert by_id["a1:upload_strava"]["depends_on"] == ["a1:ensure_summary"]
    assert by_id[TASK_AGGREGATE_REPORT]["depends_on"] == ["a1:ensure_summary", "a2:ensure_summary"]
    assert by_id[TASK_AGGREGATE_REPORT]["allow_failed_dependencies"] is True

    source_activities[0]["fit_path"] = "changed-after-run.fit"
    assert run["activities"][0]["fit_path"] == "a1.fit"
    assert load_workflow(run["workflow_id"], directory=tmp_path) == run


def test_local_factory_does_not_create_a_run_when_no_activity(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "operations.activity.workflow_factory.resolve_recent",
        lambda **kwargs: {"status": "completed", "selection": {"kind": "recent"}, "activities": []},
    )

    result = create_local_activity_run(directory=tmp_path)

    assert result["status"] == "no_activities"
    assert not list(tmp_path.glob("*.json"))


def test_local_factory_propagates_resolution_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "operations.activity.workflow_factory.resolve_recent",
        lambda **kwargs: {"status": "failed", "error": "invalid_limit", "message": "bad limit"},
    )

    result = create_local_activity_run(directory=tmp_path)

    assert result == {
        "schema_version": "activity_run_factory.v1",
        "status": "failed",
        "error": "invalid_limit",
        "message": "bad limit",
    }


def test_local_factory_keeps_generator_goals_when_building_request(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "operations.activity.workflow_factory.resolve_recent",
        lambda **kwargs: {"status": "completed", "activities": [{"activity_key": "a1", "fit_path": "a1.fit"}]},
    )

    result = create_local_activity_run(
        goals=(goal for goal in [TASK_UPLOAD_STRAVA]),
        directory=tmp_path,
    )

    assert result["run"]["request"]["goals"] == [TASK_ENSURE_SUMMARY, TASK_UPLOAD_STRAVA]
