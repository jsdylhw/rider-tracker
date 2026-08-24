from __future__ import annotations

from operations.activity.workflow_executor import execute_activity_run
from operations.activity.workflow_factory import (
    TASK_ENSURE_SUMMARY,
    TASK_UPLOAD_STRAVA,
    create_activity_run_from_activities,
)
from operations.runtime.executor import TaskExecution, TaskHandler, execute_ready_tasks
from operations.runtime.models import cancel_workflow, create_task, create_workflow, transition_task
from storage.repositories.workflow import acquire_workflow_lock


def test_runtime_executor_runs_ready_task():
    run = create_workflow(
        request={},
        activities=[{"activity_key": "a1"}],
        tasks=[create_task(task_id="a1:write", kind="write", activity_key="a1")],
    )
    calls: list[str] = []
    handlers = {
        "write": TaskHandler(execute=lambda run, task: calls.append(task["task_id"]) or TaskExecution(status="completed")),
    }

    completed = execute_ready_tasks(run, handlers=handlers)
    assert completed["workflow"]["status"] == "completed"
    assert run["tasks"][0]["status"] == "completed"
    assert calls == ["a1:write"]


def test_runtime_executor_skips_dependent_task_after_failure():
    run = create_workflow(
        request={}, activities=[{"activity_key": "a1"}],
        tasks=[
            create_task(task_id="a1:summary", kind="fail", activity_key="a1"),
            create_task(task_id="a1:upload", kind="upload", activity_key="a1", depends_on=["a1:summary"]),
        ],
    )
    handlers = {"fail": TaskHandler(execute=lambda run, task: TaskExecution(status="failed", details={"error": "bad_fit"}))}

    execute_ready_tasks(run, handlers=handlers)
    assert run["tasks"][0]["status"] == "failed"
    assert run["tasks"][1]["status"] == "skipped"
    assert run["tasks"][1]["reason"] == "dependency_failed"


def test_runtime_executor_never_starts_a_cancelled_run():
    run = create_workflow(
        request={}, activities=[{"activity_key": "a1"}],
        tasks=[create_task(task_id="a1:upload", kind="upload", activity_key="a1")],
    )
    calls: list[str] = []
    cancel_workflow(run)

    result = execute_ready_tasks(
        run,
        handlers={"upload": TaskHandler(execute=lambda _run, task: calls.append(task["task_id"]) or TaskExecution(status="completed"))},
    )

    assert result["workflow"]["status"] == "cancelled"
    assert calls == []
    assert run["tasks"][0]["status"] == "pending"


def test_runtime_executor_marks_persisted_running_task_interrupted_without_replaying():
    run = create_workflow(
        request={}, activities=[{"activity_key": "a1"}],
        tasks=[create_task(task_id="a1:upload", kind="upload", activity_key="a1")],
    )
    transition_task(run, "a1:upload", "running")
    calls: list[str] = []

    result = execute_ready_tasks(
        run,
        handlers={"upload": TaskHandler(execute=lambda _run, task: calls.append(task["task_id"]) or TaskExecution(status="completed"))},
    )

    assert result["workflow"]["status"] == "partial"
    assert run["tasks"][0]["error"] == "interrupted"
    assert calls == []


def test_activity_executor_does_not_recover_running_task_held_by_another_process(tmp_path):
    run = create_workflow(
        request={}, activities=[{"activity_key": "a1"}],
        tasks=[create_task(task_id="a1:upload", kind="upload_strava", activity_key="a1")],
        workflow_id="locked-run",
    )
    transition_task(run, "a1:upload", "running")

    with acquire_workflow_lock("locked-run", directory=tmp_path):
        result = execute_activity_run(run, directory=tmp_path)

    assert result["busy"] is True
    assert result["error"] == "workflow_locked"
    assert run["tasks"][0]["status"] == "running"


def test_activity_summary_task_persists_result(monkeypatch, tmp_path):
    fit = tmp_path / "a1.fit"
    fit.write_bytes(b"fit")
    result = create_activity_run_from_activities(
        [{"activity_key": "a1", "fit_path": str(fit)}],
        request={"source": "local", "goals": [TASK_ENSURE_SUMMARY], "force": False},
        directory=tmp_path,
    )
    run = result["run"]
    monkeypatch.setattr(
        "operations.activity.workflow_handlers.ensure_summary",
        lambda fit_path, force: {
            "status": "completed", "report_schema_version": "llm_fit_file_analysis.v2", "result_status": "analyzed",
        },
    )

    completed = execute_activity_run(run, directory=tmp_path)
    assert completed["workflow"]["status"] == "completed"
    assert run["tasks"][0]["status"] == "completed"
    assert run["tasks"][0]["report_schema_version"] == "llm_fit_file_analysis.v2"


def test_activity_upload_task_updates_activity_snapshot(monkeypatch, tmp_path):
    fit = tmp_path / "a1.fit"
    fit.write_bytes(b"fit")
    created = create_activity_run_from_activities(
        [{"activity_key": "a1", "fit_path": str(fit)}],
        request={"source": "test", "goals": [TASK_UPLOAD_STRAVA], "force": False},
        directory=tmp_path,
    )
    run = created["run"]
    calls = []
    monkeypatch.setattr("operations.activity.workflow_handlers._has_existing_report", lambda activity: True)
    monkeypatch.setattr(
        "operations.activity.workflow_handlers.upload_activity",
        lambda fit_path, force: calls.append((fit_path, force)) or {
            "status": "completed", "outcome": "uploaded", "strava_activity_id": "123",
        },
    )

    completed = execute_activity_run(run, directory=tmp_path)
    by_kind = {task["kind"]: task for task in run["tasks"]}
    assert by_kind[TASK_ENSURE_SUMMARY]["status"] == "skipped"
    assert completed["workflow"]["status"] == "completed"
    assert by_kind[TASK_UPLOAD_STRAVA]["status"] == "completed"
    assert run["activities"][0]["strava_activity_id"] == "123"
    assert calls == [(str(fit), False)]


def test_activity_upload_task_skips_known_remote_activity(tmp_path, monkeypatch):
    created = create_activity_run_from_activities(
        [{
            "activity_key": "a1",
            "fit_path": str(tmp_path / "a1.fit"),
            "strava_activity_id": "123",
        }],
        request={"source": "test", "goals": [TASK_UPLOAD_STRAVA], "force": False},
        directory=tmp_path,
    )
    run = created["run"]
    monkeypatch.setattr("operations.activity.workflow_handlers._has_existing_report", lambda activity: True)

    result = execute_activity_run(run, directory=tmp_path)

    assert result["workflow"]["status"] == "completed"
    upload = next(task for task in run["tasks"] if task["kind"] == TASK_UPLOAD_STRAVA)
    assert upload["status"] == "skipped"
    assert upload["reason"] == "already_uploaded"
