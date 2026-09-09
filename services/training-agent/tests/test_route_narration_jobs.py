from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from domain.contracts.narration_jobs import ROUTE_NARRATION_JOB
from services.narration.jobs import get_route_narration_job, submit_route_narration
from storage.repositories.job import JobStore
from storage.repositories.narration_job import NarrationJobStore, NarrationInputChanged
from worker.handlers.route_narration import generate_route_narration
from worker.runtime import Worker


def request():
    return {
        "route_fingerprint": "route_1234abcd",
        "route_name": "测试路线",
        "total_distance_m": 10_000,
        "estimated_duration_min": 50,
        "locale": "zh-CN",
        "samples": [
            {"sample_id": "sample_1", "route_distance_m": 0, "latitude": 30, "longitude": 120},
            {"sample_id": "sample_2", "route_distance_m": 10_000, "latitude": 30.1, "longitude": 120.1},
        ],
    }


def plan():
    return {
        "schema_version": "route_narration_plan.v1",
        "plan_id": "narration_test",
        "route_fingerprint": "route_1234abcd",
        "status": "ready",
        "route": {"name": "测试路线", "total_distance_m": 10_000},
        "items": [{
            "item_id": "item_1",
            "route_distance_m": 0,
            "latitude": 30,
            "longitude": 120,
            "title": "起点",
            "summary": "测试内容",
        }],
        "warnings": [],
    }


def worker(store, *, research=None, compose=None, ai_available=True):
    return Worker({
        ROUTE_NARRATION_JOB: lambda context, payload: generate_route_narration(
            context,
            payload,
            research=research or (lambda _payload: {"anchors": [], "sources": {}, "warnings": []}),
            compose=compose or (lambda _payload, _research: plan()),
            ai_available=ai_available,
        ),
    }, store=store)


def test_submit_replay_uses_full_input_hash_and_force_creates_new_job(tmp_path):
    store = JobStore(tmp_path / "jobs.db")
    first = submit_route_narration(request(), store=store)
    replay = submit_route_narration(request(), store=store)
    forced = submit_route_narration(request(), force=True, store=store)

    assert first["job_id"] == replay["job_id"]
    assert forced["job_id"] != first["job_id"]
    assert first["route_fingerprint"] == "route_1234abcd"
    assert first["status"] == "queued"
    assert "samples" not in json.dumps(first)


def test_worker_checkpoints_and_saves_large_plan_outside_generic_job_row(tmp_path):
    store = JobStore(tmp_path / "jobs.db")
    submitted = submit_route_narration(request(), store=store)

    assert worker(store).run_once()

    result = get_route_narration_job(submitted["job_id"], store=store)
    generic = store.get(submitted["job_id"])
    assert result["status"] == "succeeded"
    assert result["progress"] == {"stage": "saving_plan", "completed": 3, "total": 3}
    assert result["plan"]["plan_id"] == "narration_test"
    assert generic["result_ref"] == {
        "job_id": submitted["job_id"],
        "result_type": "route_narration",
        "route_fingerprint": "route_1234abcd",
        "plan_id": "narration_test",
    }
    assert "items" not in json.dumps(generic)


def test_model_unavailable_returns_controlled_retryable_error(tmp_path):
    store = JobStore(tmp_path / "jobs.db")
    submitted = submit_route_narration(request(), store=store)

    worker(store, ai_available=False).run_once()

    result = get_route_narration_job(submitted["job_id"], store=store)
    assert result["status"] == "failed"
    assert result["error"]["code"] == "ai_unavailable"
    assert result["error"]["retryable"] is True


def test_cancel_during_composition_discards_plan(tmp_path):
    store = JobStore(tmp_path / "jobs.db")
    submitted = submit_route_narration(request(), store=store)

    def cancel_then_compose(_payload, _research):
        store.cancel(submitted["job_id"])
        return plan()

    worker(store, compose=cancel_then_compose).run_once()

    assert get_route_narration_job(submitted["job_id"], store=store)["status"] == "cancelled"
    with store._connection() as conn:
        row = conn.execute(
            "SELECT status,plan_json FROM route_narration_results WHERE job_id=?",
            (submitted["job_id"],),
        ).fetchone()
    assert row["status"] == "pending" and row["plan_json"] is None


def test_repository_rejects_changed_payload_before_result_commit(tmp_path):
    store = JobStore(tmp_path / "jobs.db")
    submitted = submit_route_narration(request(), store=store)
    claim = store.claim("worker", [ROUTE_NARRATION_JOB])
    changed = {**request(), "route_name": "另一条路线"}

    with pytest.raises(NarrationInputChanged):
        NarrationJobStore(store).commit(claim, changed, plan())

    assert get_route_narration_job(submitted["job_id"], store=store)["status"] == "running"


def test_recovery_reuses_plan_committed_before_generic_finish(tmp_path):
    now = [100.0]
    store = JobStore(tmp_path / "jobs.db", clock=lambda: now[0])
    submitted = submit_route_narration(request(), store=store)
    calls = []

    class Crash(BaseException):
        pass

    original_finish = store.finish
    first_finish = [True]

    def crash_once(*args, **kwargs):
        if first_finish[0]:
            first_finish[0] = False
            raise Crash()
        return original_finish(*args, **kwargs)

    store.finish = crash_once
    with pytest.raises(Crash):
        worker(store, research=lambda _payload: calls.append("research") or {}).run_once()
    now[0] += 31
    worker(store, research=lambda _payload: calls.append("research") or {}).run_once()

    assert calls == ["research"]
    assert get_route_narration_job(submitted["job_id"], store=store)["status"] == "succeeded"


def test_schema_eleven_upgrade_preserves_existing_jobs_and_adds_narration_results(tmp_path):
    from storage.database import SCHEMA_VERSION, initialize_database

    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        initialize_database(conn)
        conn.execute("DROP TABLE route_narration_results")
        conn.execute("PRAGMA user_version=11")
        conn.execute(
            """INSERT INTO jobs
            (job_id,job_type,request_id,scope,input_json,input_hash,status,recovery,max_attempts,created_at,updated_at)
            VALUES ('old','test','old-request','local','{}','hash','succeeded','fail',1,1,1)"""
        )
    root = Path(__file__).resolve().parents[3]
    result = subprocess.run(
        [sys.executable, str(root / "scripts/database-tool.py"), "ensure", "--database", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    upgraded = json.loads(result.stdout)

    assert upgraded["schema_version"] == SCHEMA_VERSION
    assert upgraded["startup_action"] == "migrated"
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT status FROM jobs WHERE job_id='old'").fetchone()[0] == "succeeded"
        assert conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='route_narration_results'"
        ).fetchone()[0] == "route_narration_results"
    with sqlite3.connect(upgraded["backup_path"]) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 11
