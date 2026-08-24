from __future__ import annotations

from operations.activity.workflow_executor import execute_activity_run
from operations.activity.workflow_factory import TASK_UPLOAD_STRAVA, create_activity_run_from_activities
from operations.activity.workflow_service import (
    get_activity_workflow,
    retry_activity_workflow,
    sync_and_start_activity_workflow,
)
from operations.runtime.models import cancel_workflow
from storage.repositories.workflow import save_workflow
from storage.repositories.workflow import acquire_workflow_lock


def test_service_runs_and_retries_persisted_upload_run(monkeypatch, tmp_path):
    fit = tmp_path / "a1.fit"
    fit.write_bytes(b"fit")
    created = create_activity_run_from_activities(
        [{"activity_key": "a1", "fit_path": str(fit)}],
        request={"source": "test", "goals": [TASK_UPLOAD_STRAVA], "force": False},
        directory=tmp_path,
    )
    run = created["run"]
    workflow_id = run["workflow_id"]
    monkeypatch.setattr("operations.activity.workflow_handlers._has_existing_report", lambda activity: True)
    monkeypatch.setattr(
        "operations.activity.workflow_handlers.upload_activity",
        lambda *args, **kwargs: {"status": "failed", "error": "network_error", "message": "offline"},
    )

    failed = execute_activity_run(run, directory=tmp_path)
    assert failed["workflow"]["status"] == "partial"
    assert next(task for task in run["tasks"] if task["kind"] == TASK_UPLOAD_STRAVA)["status"] == "failed"

    visible = get_activity_workflow(workflow_id, directory=tmp_path)
    assert visible["status"] == "partial"
    assert "处理部分完成" in visible["answer"]
    assert "Strava 上传失败：offline" in visible["answer"]

    monkeypatch.setattr(
        "operations.activity.workflow_handlers.upload_activity",
        lambda *args, **kwargs: {"status": "completed", "outcome": "uploaded", "strava_activity_id": "456"},
    )
    retried = retry_activity_workflow(workflow_id, directory=tmp_path)
    assert retried["retried_task_ids"] == ["a1:upload_strava"]
    upload = next(task for task in retried["tasks"] if task["kind"] == TASK_UPLOAD_STRAVA)
    assert retried["workflow"]["status"] == "completed"
    assert upload["attempts"] == 2
    assert retried["activities"][0]["strava_activity_id"] == "456"
    assert "Strava 上传已完成（activity_id=456）" in retried["answer"]


def test_service_reports_missing_run_and_nothing_to_retry(tmp_path):
    assert get_activity_workflow("missing", directory=tmp_path)["status"] == "not_found"

    created = create_activity_run_from_activities(
        [{"activity_key": "a1", "fit_path": str(tmp_path / "a1.fit")}],
        request={"source": "test", "goals": ["ensure_summary"], "force": False},
        directory=tmp_path,
    )
    result = retry_activity_workflow(created["run"]["workflow_id"], directory=tmp_path)
    assert result["status"] == "nothing_to_retry"


def test_service_rejects_retry_for_cancelled_run(tmp_path):
    created = create_activity_run_from_activities(
        [{"activity_key": "a1", "fit_path": str(tmp_path / "a1.fit")}],
        request={"source": "test", "goals": ["ensure_summary"], "force": False},
        directory=tmp_path,
    )
    run = created["run"]
    cancel_workflow(run)
    save_workflow(run, directory=tmp_path)

    result = retry_activity_workflow(run["workflow_id"], directory=tmp_path)

    assert result["status"] == "failed"
    assert result["error"] == "retry_not_available"
    assert "cancelled workflow" in result["message"]


def test_service_does_not_retry_while_another_executor_holds_the_run_lock(tmp_path):
    created = create_activity_run_from_activities(
        [{"activity_key": "a1", "fit_path": str(tmp_path / "a1.fit")}],
        request={"source": "test", "goals": ["ensure_summary"], "force": False},
        directory=tmp_path,
    )
    run = created["run"]
    from operations.runtime.models import transition_task
    transition_task(run, "a1:ensure_summary", "failed", error="temporary")
    save_workflow(run, directory=tmp_path)

    with acquire_workflow_lock(run["workflow_id"], directory=tmp_path):
        result = retry_activity_workflow(run["workflow_id"], directory=tmp_path)

    assert result["status"] == "busy"
    assert result["error"] == "workflow_locked"


def test_service_retry_recovers_persisted_running_task_after_lock_is_acquired(monkeypatch, tmp_path):
    fit = tmp_path / "a1.fit"
    fit.write_bytes(b"fit")
    created = create_activity_run_from_activities(
        [{"activity_key": "a1", "fit_path": str(fit)}],
        request={"source": "test", "goals": ["ensure_summary"], "force": False},
        directory=tmp_path,
    )
    run = created["run"]
    from operations.runtime.models import transition_task
    transition_task(run, "a1:ensure_summary", "running")
    save_workflow(run, directory=tmp_path)
    monkeypatch.setattr(
        "operations.activity.workflow_handlers.ensure_summary",
        lambda _path, force: {
            "status": "completed", "report_schema_version": "llm_fit_file_analysis.v2", "result_status": "analyzed",
        },
    )

    result = retry_activity_workflow(run["workflow_id"], directory=tmp_path)

    task = next(task for task in result["tasks"] if task["task_id"] == "a1:ensure_summary")
    assert result["workflow"]["status"] == "completed"
    assert result["retried_task_ids"] == ["a1:ensure_summary"]
    assert task["status"] == "completed"
    assert task["attempts"] == 2
    assert task["attempt_history"][0]["details"]["error"] == "interrupted"


def test_sync_service_freezes_exact_indexed_items_and_persists_sync_metadata(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "operations.activity.workflow_service.sync_recent",
        lambda count, force_download=False: {
            "status": "partial", "downloaded": 1, "skipped": 1, "failed": 1,
            "failed_items": [{"id": "remote-failed"}],
            "activities": [
                {"activity_key": "a1", "activity_id": "remote-a1", "path": "/fit/a1.fit", "sport_type": "cycling", "start_time_local": "2026-07-29T08:00:00"},
                {"activity_key": "a2", "activity_id": "remote-a2", "path": "/fit/a2.fit", "sport_type": "running", "start_time_local": "2026-07-29T19:00:00"},
            ],
        },
    )
    def complete_run(run, **kwargs):
        for task in run["tasks"]:
            task["status"] = "completed"
        return {"workflow": {"status": "completed"}, "waiting_for": []}

    monkeypatch.setattr(
        "operations.activity.workflow_service.execute_activity_run",
        complete_run,
    )

    result = sync_and_start_activity_workflow(
        count=5, goals=["ensure_summary", "upload_strava"], directory=tmp_path,
    )

    assert result["created"] is True
    assert result["status"] == "partial"
    assert [item["activity_key"] for item in result["activities"]] == ["a1", "a2"]
    from storage.repositories.workflow import load_workflow
    run = load_workflow(result["workflow_id"], directory=tmp_path)
    assert run["request"]["source"] == "garmin_sync"
    assert run["request"]["selection"]["activity_keys"] == ["a1", "a2"]
    assert run["request"]["sync"] == {
        "schema_version": "activity_workflow_sync.v1", "requested_count": 5, "status": "partial",
        "downloaded": 1, "skipped": 1, "failed": 1, "indexed_activity_keys": ["a1", "a2"],
        "failed_items": [{"id": "remote-failed"}], "index_failed": 0,
        "index_errors": [], "force_download": False,
    }


def test_sync_service_surfaces_index_failure_without_creating_workflow(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "operations.activity.workflow_service.sync_recent",
        lambda count, force_download=False: {
            "status": "partial", "downloaded": 1, "skipped": 0, "failed": 0,
            "activities": [], "failed_items": [], "index_failed": 1,
            "index_errors": [{"path": "broken.fit", "error": "FitParseError"}],
            "force_download": force_download,
        },
    )

    result = sync_and_start_activity_workflow(count=1, directory=tmp_path)

    assert result["status"] == "failed"
    assert result["error"] == "activity_index_failed"
    assert result["sync"]["index_failed"] == 1
    assert result["sync"]["index_errors"][0]["error"] == "FitParseError"
    assert list(tmp_path.glob("*.json")) == []
