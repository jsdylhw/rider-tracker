from __future__ import annotations

import pytest

from operations.runtime.models import (
    WorkflowStateError,
    cancel_workflow,
    create_task,
    create_workflow,
    retry_failed_tasks,
    retry_task,
    recover_interrupted_tasks,
    transition_task,
    workflow_overview,
)
from storage.repositories.workflow import load_workflow, save_workflow, workflow_path


def _run():
    return create_workflow(
        request={"source": "local", "goals": ["ensure_summary", "upload_strava"]},
        activities=[{"activity_key": "a1", "fit_path": "a1.fit"}],
        tasks=[
            create_task(task_id="a1:summary", kind="ensure_summary", activity_key="a1"),
            create_task(task_id="a1:upload", kind="upload_strava", activity_key="a1", depends_on=["a1:summary"]),
        ],
        workflow_id="workflow-test",
    )


def test_workflow_models_track_per_activity_tasks_and_dependencies():
    run = _run()
    assert run["status"] == "active"
    assert run["tasks"][1]["depends_on"] == ["a1:summary"]

    transition_task(run, "a1:summary", "running")
    transition_task(run, "a1:summary", "completed", summary_path="a1.summary.json")
    transition_task(run, "a1:upload", "running")
    transition_task(run, "a1:upload", "failed", error="network_error")

    overview = workflow_overview(run)
    assert overview["status"] == "partial"
    assert overview["tasks_by_kind"]["ensure_summary"]["completed"] == 1
    assert overview["tasks_by_kind"]["upload_strava"]["failed"] == 1


def test_only_failed_task_can_be_retried():
    run = _run()
    with pytest.raises(WorkflowStateError, match="pending -> pending"):
        retry_task(run, "a1:summary")

    transition_task(run, "a1:summary", "failed", error="analysis_error")
    retried = retry_task(run, "a1:summary")
    assert retried["status"] == "pending"
    assert retried["attempt_history"][0]["details"]["error"] == "analysis_error"
    assert run["status"] == "active"


def test_interrupted_running_task_becomes_failed_until_explicit_retry():
    run = _run()
    transition_task(run, "a1:summary", "running")

    recovered = recover_interrupted_tasks(run)

    assert recovered == ["a1:summary"]
    task = run["tasks"][0]
    assert task["status"] == "failed"
    assert task["error"] == "interrupted"
    assert "retry explicitly" in task["message"]
    retry_task(run, "a1:summary")
    assert task["status"] == "pending"
    assert task["attempt_history"][0]["details"]["error"] == "interrupted"


def test_cancelled_workflow_rejects_retry_and_running_recovery():
    run = _run()
    transition_task(run, "a1:summary", "running")
    cancel_workflow(run)

    assert recover_interrupted_tasks(run) == []
    with pytest.raises(WorkflowStateError, match="cancelled workflow"):
        retry_failed_tasks(run)


def test_retry_failed_tasks_restores_skipped_dependents_and_partial_aggregate():
    run = create_workflow(
        request={},
        activities=[{"activity_key": "a1"}],
        tasks=[
            create_task(task_id="a1:summary", kind="summary", activity_key="a1"),
            create_task(task_id="a1:upload", kind="upload", activity_key="a1", depends_on=["a1:summary"]),
            create_task(
                task_id="aggregate", kind="aggregate", depends_on=["a1:summary"], allow_failed_dependencies=True,
            ),
        ],
    )
    transition_task(run, "a1:summary", "running")
    transition_task(run, "a1:summary", "failed", error="bad_fit")
    transition_task(run, "a1:upload", "skipped", reason="dependency_failed")
    transition_task(run, "aggregate", "running")
    transition_task(run, "aggregate", "completed", report={"status": "partial"})

    revived = retry_failed_tasks(run)

    assert revived == ["a1:summary", "a1:upload", "aggregate"]
    assert [task["status"] for task in run["tasks"]] == ["pending", "pending", "pending"]
    assert run["tasks"][2]["attempt_history"][0]["details"]["report"] == {"status": "partial"}
    assert run["status"] == "active"


def test_task_validation_rejects_unknown_activity_and_dependency():
    with pytest.raises(WorkflowStateError, match="unknown activity"):
        create_workflow(
            request={}, activities=[{"activity_key": "a1"}],
            tasks=[create_task(task_id="other:summary", kind="ensure_summary", activity_key="other")],
        )
    with pytest.raises(WorkflowStateError, match="missing dependencies"):
        create_workflow(
            request={}, activities=[{"activity_key": "a1"}],
            tasks=[create_task(task_id="a1:upload", kind="upload_strava", activity_key="a1", depends_on=["missing"])],
        )


def test_workflow_store_round_trips_atomically(tmp_path):
    run = _run()
    saved = save_workflow(run, directory=tmp_path)
    restored = load_workflow("workflow-test", directory=tmp_path)
    assert saved == tmp_path / "workflow-test.json"
    assert restored == run
    assert not list(tmp_path.glob(".*.tmp"))


def test_workflow_store_rejects_path_traversal(tmp_path):
    with pytest.raises(ValueError, match="invalid workflow_id"):
        workflow_path("../outside", directory=tmp_path)
