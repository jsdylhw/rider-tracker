from functools import partial
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from domain.contracts.report_jobs import REPORT_REBUILD_JOB
from operations.activity.report_batch import (
    get_activity_report_job, submit_activity_report_rebuild, cancel_activity_report_job,
)
from project_paths import resolve_project_path, runtime_paths
from storage.repositories.activity import ActivityStore, file_content_key
from storage.repositories.job import JobStore, JobConflict, LeaseLost
from storage.repositories.report_job import ReportJobStore, ReportCancelled
from worker.runtime import Worker
from worker.handlers.report_rebuild import rebuild_reports


def seed(tmp_path, count=2):
    store = ActivityStore()
    for index in range(count):
        fit = tmp_path / f"ride-{index}.fit"
        fit.write_bytes(f"fit-{index}".encode())
        store.upsert_activity({"activity_key": f"stable-{index}", "fit_path": str(fit), "name": f"Ride {index}"})
    return store


def report(fit_path, *, activity_key, **kwargs):
    assert kwargs.get("persist") is False
    return {"schema_version": "llm_fit_file_analysis.v2", "activity_key": activity_key,
            "fit_path": str(fit_path), "status": "analyzed_query",
            "activity_metrics": {"schema_version": "activity_metrics.v2"},
            "analysis_summary": {"schema_version": "activity_analysis_summary.v1"},
            "markdown_report": "# rebuilt", "strava_summary": "summary"}


def worker(analyze=report, jobs=None, ai_available=True):
    return Worker({REPORT_REBUILD_JOB: partial(rebuild_reports, analyze=analyze, ai_available=ai_available)}, store=jobs)


def test_submit_only_freezes_selection_and_replay_reuses_job(tmp_path):
    store = seed(tmp_path)
    submitted = submit_activity_report_rebuild(request_id="one")
    assert submitted["status"] == "queued" and submitted["worker"] == "unavailable"
    assert store.report_counts() == {}
    assert get_activity_report_job(submitted["job_id"])["total"] == 2
    store.upsert_activity({"activity_key": "later", "fit_path": str(tmp_path / "later.fit")})
    assert submit_activity_report_rebuild(request_id="one")["job_id"] == submitted["job_id"]
    with pytest.raises(JobConflict):
        submit_activity_report_rebuild(request_id="one", scope="outdated")
    assert worker().run_once()
    done = get_activity_report_job(submitted["job_id"])
    assert done["status"] == "completed" and done["completed"] == 2 and done["total"] == 2
    assert store.get_report("stable-0")["status"] == "analyzed"
    assert store.get_activity("stable-0")["name"] == "Ride 0"
    assert store.count_activities() == 3
    assert "fit_path" not in json.dumps(done)


def test_partial_failure_and_targeted_retry(tmp_path):
    store = seed(tmp_path)
    def fail_second(path, **kwargs):
        if kwargs["activity_key"] == "stable-1":
            raise RuntimeError("secret-token /private.fit")
        return report(path, **kwargs)
    job = submit_activity_report_rebuild()
    worker(fail_second).run_once()
    view = get_activity_report_job(job["job_id"])
    assert view["status"] == "partial" and view["completed"] == 1 and view["failed"] == 1
    assert "secret" not in json.dumps(view)
    assert JobStore().get(job["job_id"])["status"] == "failed"
    assert JobStore().get(job["job_id"])["result_ref"]["failed"] == 1
    retry = submit_activity_report_rebuild(activity_keys=["stable-1"])
    worker().run_once()
    assert get_activity_report_job(retry["job_id"])["completed"] == 1
    assert store.get_report_record("stable-0")["revision"] == 1
    outdated = submit_activity_report_rebuild(scope="outdated")
    worker().run_once()
    assert get_activity_report_job(outdated["job_id"])["total"] == 0


@pytest.mark.parametrize("scope", ["all", "outdated"])
def test_invalid_selection_does_not_leave_queued_job(tmp_path, scope):
    seed(tmp_path)
    with pytest.raises(ValueError):
        submit_activity_report_rebuild(scope=scope, activity_keys=["stable-0", "missing"], request_id="bad")
    with JobStore()._connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE request_id='bad'").fetchone()[0] == 0


def test_schema_ten_upgrade_preserves_existing_job_and_report(tmp_path):
    from pathlib import Path
    import subprocess
    import sys
    from storage.database import SCHEMA_VERSION

    store = seed(tmp_path, 1)
    fit = tmp_path / "ride-0.fit"
    store.save_report(report(fit, activity_key="stable-0", persist=False))
    jobs = JobStore(runtime_paths().database)
    previous = jobs.submit("test", "previous", {})
    with sqlite3.connect(jobs.path) as conn:
        conn.execute("DROP TABLE report_job_items")
        conn.execute("PRAGMA user_version=10")
    root = Path(__file__).resolve().parents[3]
    result = subprocess.run([sys.executable, str(root / "scripts/database-tool.py"), "ensure",
                             "--database", str(jobs.path)], capture_output=True, text=True, check=True)
    upgraded = json.loads(result.stdout)
    assert upgraded["schema_version"] == SCHEMA_VERSION
    assert upgraded["startup_action"] == "migrated"
    assert jobs.get(previous["job_id"]) == previous
    assert store.get_report_record("stable-0")["revision"] == 1
    with sqlite3.connect(upgraded["backup_path"]) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 10
        assert conn.execute("SELECT COUNT(*) FROM activity_reports").fetchone()[0] == 1
        assert conn.execute("SELECT job_id FROM jobs").fetchone()[0] == previous["job_id"]
    submitted = submit_activity_report_rebuild(activity_keys=["stable-0"])
    worker().run_once()
    assert get_activity_report_job(submitted["job_id"])["completed"] == 1


def test_debug_cli_submit_without_worker_query_and_cancel(tmp_path):
    from typer.testing import CliRunner
    from app.debug_cli import app

    seed(tmp_path, 1)
    runner = CliRunner()
    submitted = runner.invoke(app, ["rebuild-v2-reports", "--request-id", "cli", "--wait"])
    assert submitted.exit_code == 0, submitted.output
    assert "start:worker" in submitted.output and '"status": "queued"' in submitted.output
    job = submit_activity_report_rebuild(request_id="cli")
    queried = runner.invoke(app, ["report-job", job["job_id"]])
    assert queried.exit_code == 0 and '"total": 1' in queried.output
    cancelled = runner.invoke(app, ["report-job", job["job_id"], "--cancel"])
    assert cancelled.exit_code == 0 and '"status": "cancelled"' in cancelled.output
    assert not worker().run_once()


def test_recovery_skips_committed_items(tmp_path):
    store = seed(tmp_path)
    jobs = JobStore()
    now = [100.0]
    jobs.clock = lambda: now[0]
    job = submit_activity_report_rebuild()
    calls = []
    class Crash(BaseException):
        pass
    def crash_after_first(path, **kwargs):
        calls.append(kwargs["activity_key"])
        if kwargs["activity_key"] == "stable-1":
            raise Crash()
        return report(path, **kwargs)
    with pytest.raises(Crash):
        worker(crash_after_first, jobs).run_once()
    assert store.get_report_record("stable-0")["revision"] == 1
    now[0] += 31
    def finish(path, **kwargs):
        calls.append(kwargs["activity_key"])
        return report(path, **kwargs)
    worker(finish, jobs).run_once()
    assert calls.count("stable-0") == 1
    assert store.get_report_record("stable-0")["revision"] == 1
    assert get_activity_report_job(job["job_id"])["completed"] == 2


def test_report_and_item_checkpoint_roll_back_together(tmp_path, monkeypatch):
    store = seed(tmp_path, 1)
    job = submit_activity_report_rebuild()
    jobs = JobStore()
    claim = jobs.claim("worker", [REPORT_REBUILD_JOB])
    repository = ReportJobStore(jobs)
    item = repository.pending(job["job_id"])[0]
    repository.prepare(claim, "stable-0", file_content_key(resolve_project_path(item["fit_path"])))
    monkeypatch.setattr(repository, "_progress", lambda *_: (_ for _ in ()).throw(RuntimeError("rollback")))
    with pytest.raises(RuntimeError):
        repository.commit(claim, "stable-0", report(item["fit_path"], activity_key="stable-0", persist=False))
    assert store.get_report("stable-0") is None
    assert repository.pending(job["job_id"])[0]["status"] == "pending"


def test_expired_worker_cannot_commit_report(tmp_path):
    store = seed(tmp_path, 1)
    jobs = JobStore()
    now = [100.0]
    jobs.clock = lambda: now[0]
    job = submit_activity_report_rebuild()
    first = jobs.claim("old", [REPORT_REBUILD_JOB], lease_seconds=1)
    item = ReportJobStore(jobs).pending(job["job_id"])[0]
    now[0] += 2
    jobs.claim("new", [REPORT_REBUILD_JOB])
    with pytest.raises(LeaseLost):
        ReportJobStore(jobs).commit(first, "stable-0", report(item["fit_path"], activity_key="stable-0", persist=False))
    assert store.get_report("stable-0") is None


def test_cancel_is_rechecked_in_report_commit_transaction(tmp_path):
    store = seed(tmp_path, 1)
    job = submit_activity_report_rebuild()
    jobs = JobStore()
    claim = jobs.claim("worker", [REPORT_REBUILD_JOB])
    repository = ReportJobStore(jobs)
    item = repository.pending(job["job_id"])[0]
    repository.prepare(claim, "stable-0", file_content_key(resolve_project_path(item["fit_path"])))
    jobs.cancel(job["job_id"])
    with pytest.raises(ReportCancelled):
        repository.commit(claim, "stable-0", report(item["fit_path"], activity_key="stable-0", persist=False))
    assert store.get_report("stable-0") is None


def test_cancel_during_model_call_discards_result(tmp_path):
    store = seed(tmp_path, 1)
    job = submit_activity_report_rebuild()
    def cancelled(path, **kwargs):
        cancel_activity_report_job(job["job_id"])
        return report(path, **kwargs)
    worker(cancelled).run_once()
    assert get_activity_report_job(job["job_id"])["status"] == "cancelled"
    assert store.get_report("stable-0") is None
    assert get_activity_report_job(job["job_id"])["completed"] == 0


@pytest.mark.parametrize("mutation", ["report", "file", "delete"])
def test_changed_input_does_not_overwrite_new_state(tmp_path, mutation):
    store = seed(tmp_path, 1)
    job = submit_activity_report_rebuild()
    def changed(path, **kwargs):
        result = report(path, **kwargs)
        if mutation == "report":
            store.save_report({**result, "markdown_report": "# newer manual report"})
        elif mutation == "file":
            path.write_bytes(b"new content")
        else:
            store.delete_rider_activity("stable-0")
        return result
    worker(changed).run_once()
    view = get_activity_report_job(job["job_id"])
    assert view["status"] == "failed" and view["activities"][0]["error"] == "input_changed"
    if mutation == "report":
        assert store.get_report("stable-0")["markdown_report"] == "# newer manual report"
    else:
        assert store.get_report("stable-0") is None


def test_no_ai_marks_items_failed_without_calling_model(tmp_path):
    seed(tmp_path, 1)
    job = submit_activity_report_rebuild()
    worker(lambda *_args, **_kwargs: pytest.fail("must not call AI"), ai_available=False).run_once()
    assert get_activity_report_job(job["job_id"])["activities"][0]["error"] == "ai_unavailable"


def test_real_analyzer_uses_stable_identity_and_atomic_facts(tmp_path, monkeypatch, sample_parsed_fit):
    store = seed(tmp_path, 1)
    monkeypatch.setattr("agent.analysis.agent.parse_fit", lambda _: sample_parsed_fit)
    monkeypatch.setattr("agent.analysis.agent.analyze_with_llm", lambda *_args, **_kwargs: {
        "model": "fake", "markdown_report": "# actual analyzer", "strava_summary": "summary", "analysis_summary": {},
    })
    job = submit_activity_report_rebuild()
    worker(analyze=None).run_once()
    assert get_activity_report_job(job["job_id"])["completed"] == 1
    assert store.count_activities() == 1
    assert store.get_facts("stable-0") is not None
    assert store.get_report("stable-0")["activity_key"] == "stable-0"


def test_report_api_replay_validation_and_public_details(tmp_path, monkeypatch):
    from app import api
    monkeypatch.setattr(api, "load_config", lambda: {})
    seed(tmp_path, 1)
    client = TestClient(api.app)
    body = {"job_type": REPORT_REBUILD_JOB, "request_id": "api-report", "payload": {"activity_keys": ["stable-0"]}}
    reply = client.post("/api/jobs", json=body)
    assert reply.status_code == 202
    job_id = reply.json()["job_id"]
    assert client.post("/api/jobs", json=body).json()["job_id"] == job_id
    assert client.get(f"/api/jobs/{job_id}/report-rebuild").json()["total"] == 1
    assert "fit_path" not in client.get(f"/api/jobs/{job_id}/report-rebuild").text
    assert client.post("/api/jobs", json={**body, "request_id": "bad", "payload": {"activity_keys": ["missing"]}}).status_code == 422
    assert client.post(f"/api/jobs/{job_id}/cancel").json()["status"] == "cancelled"


def test_agent_submission_replays_across_context_restart(tmp_path):
    from agent.main_agent.context import AgentContext
    from agent.tools.handlers.activity_operations import rebuild_activity_reports
    seed(tmp_path, 1)
    def context():
        return AgentContext(session_id="one", workspace_id="one", request_id="same-turn")
    first = rebuild_activity_reports({"scope": "all"}, context())
    second = rebuild_activity_reports({"scope": "all"}, context())
    assert first["job_id"] == second["job_id"]
