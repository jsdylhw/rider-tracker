from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict
import pytest

from app.job_api import create_job_router
from services.jobs import JobType
from storage.database import initialize_database, SCHEMA_VERSION
from storage.repositories.job import JobConflict, JobStore, LeaseLost
from worker.runtime import Worker


@pytest.fixture
def queue(tmp_path):
    now = [100.0]
    store = JobStore(tmp_path / "queue.db", clock=lambda: now[0])
    return store, now


def test_request_replay_survives_new_store_and_rejects_changed_input(queue):
    store, _ = queue
    job = store.submit("test", "req", {"value": 1})
    assert JobStore(store.path).submit("test", "req", {"value": 1}) == job
    with pytest.raises(JobConflict):
        store.submit("test", "req", {"value": 2})
    with pytest.raises(JobConflict):
        store.submit("other", "req", {"value": 1})
    assert store.submit("test", "req", {"value": 2}, scope="another")["job_id"] != job["job_id"]
    with pytest.raises(KeyError):
        store.get(job["job_id"], scope="another")


def test_atomic_claim_and_expired_execution_cannot_write(queue):
    store, now = queue
    job = store.submit("test", "req", {}, recovery="retry", max_attempts=2)
    with ThreadPoolExecutor(2) as pool:
        claims = list(pool.map(lambda name: store.claim(name, ["test"], lease_seconds=10), ["one", "two"]))
    assert sum(c is not None for c in claims) == 1
    first = next(c for c in claims if c)
    now[0] += 11
    second = store.claim("new", ["test"], lease_seconds=10)
    assert second["job_id"] == job["job_id"]
    for operation in (store.renew, store.checkpoint, store.finish):
        with pytest.raises(LeaseLost):
            operation(job["job_id"], first["token"])
    store.finish(job["job_id"], second["token"], result_ref={"report_id": "report"})
    assert store.get(job["job_id"])["status"] == "succeeded"
    assert store.submit("test", "req", {})["status"] == "succeeded"


@pytest.mark.parametrize("recovery,max_attempts", [("fail", 3), ("retry", 1)])
def test_expiry_does_not_blindly_repeat_side_effects(queue, recovery, max_attempts):
    store, now = queue
    job = store.submit("upload", "req", {}, recovery=recovery, max_attempts=max_attempts)
    store.claim("one", ["upload"], lease_seconds=10)
    now[0] += 11
    assert store.claim("two", ["upload"]) is None
    assert store.get(job["job_id"])["error"]["code"] == "worker_interrupted"


def test_cancel_queued_running_expired_and_completed(queue):
    store, now = queue
    pending = store.submit("test", "pending", {})
    assert store.cancel(pending["job_id"])["status"] == "cancelled"
    assert store.claim("one", ["test"]) is None
    running = store.submit("test", "running", {})
    claim = store.claim("one", ["test"])
    assert store.cancel(running["job_id"])["status"] == "running"
    assert store.checkpoint(running["job_id"], claim["token"])
    store.finish(running["job_id"], claim["token"], result_ref={"ignored": True})
    result = store.get(running["job_id"])
    assert result["status"] == "cancelled" and result["result_ref"] is None
    done = store.submit("test", "done", {})
    claim = store.claim("one", ["test"])
    store.finish(done["job_id"], claim["token"])
    assert store.cancel(done["job_id"])["status"] == "succeeded"
    expired = store.submit("test", "expired", {}, recovery="retry", max_attempts=2)
    store.claim("one", ["test"], lease_seconds=1)
    store.cancel(expired["job_id"])
    now[0] += 2
    store.recover()
    assert store.get(expired["job_id"])["status"] == "cancelled"


def test_worker_progress_failure_redaction_and_allowlist(queue):
    store, _ = queue
    def handler(ctx, payload):
        ctx.checkpoint({"stage": "analyzing", "completed": 1, "total": 2})
        raise RuntimeError("secret-token C:/private/file.fit")
    job = store.submit("test", "req", {"secret": "private"})
    assert not Worker({"other": handler}, store=store).run_once()
    assert Worker({"test": handler}, store=store).run_once()
    view = store.get(job["job_id"])
    assert view["status"] == "failed"
    assert view["progress"]["completed"] == 1
    text = json.dumps(view)
    assert "secret" not in text and "private" not in text and "input_json" not in text


def test_worker_availability_expires(queue):
    store, now = queue
    assert store.availability()["worker"] == "unavailable"
    store.heartbeat("one", ["test"])
    assert store.availability() == {"worker": "available", "job_types": ["test"]}
    now[0] += 16
    assert store.availability()["worker"] == "unavailable"


def test_job_api_authorization_validation_and_durable_status(tmp_path):
    class Input(BaseModel):
        model_config = ConfigDict(extra="forbid")
        value: int
    def authorize(request: Request):
        if request.headers.get("X-API-Token") != "test":
            raise HTTPException(401)
    path = tmp_path / "api.db"
    def make_client():
        app = FastAPI()
        app.include_router(create_job_router(authorize, types={"test": JobType(Input)}, store_factory=lambda: JobStore(path)))
        return TestClient(app, headers={"X-API-Token": "test"})
    client = make_client()
    assert client.get("/api/jobs/capabilities", headers={"X-API-Token": "wrong"}).status_code == 401
    assert client.post("/api/jobs", json={"job_type": "shell", "request_id": "r", "payload": {}}).status_code == 422
    assert client.post("/api/jobs", json={"job_type": "test", "request_id": "r", "payload": {"secret": "x"}}).status_code == 422
    invalid = client.post("/api/jobs", json={"job_type": "test", "request_id": "r", "payload": "private-input"})
    assert invalid.status_code == 422 and invalid.json()["schema_version"] == "error.v1"
    assert "private-input" not in invalid.text
    body = {"job_type": "test", "request_id": "r", "payload": {"value": 1}}
    response = client.post("/api/jobs", json=body)
    assert response.status_code == 202
    job_id = response.json()["job_id"]
    assert make_client().get(f"/api/jobs/{job_id}").json() == response.json()
    assert client.post("/api/jobs", json={**body, "payload": {"value": 2}}).status_code == 409
    assert client.get("/api/jobs/missing").json()["code"] == "not_found"
    assert client.post(f"/api/jobs/{job_id}/cancel").json()["status"] == "cancelled"
    assert client.get("/api/jobs/capabilities").json()["worker"] == "unavailable"


def test_production_has_no_test_submission_types(monkeypatch):
    from app import api
    monkeypatch.setattr(api, "load_config", lambda: {})
    client = TestClient(api.app)
    assert client.get("/api/jobs/capabilities").json()["supported_job_types"] == ["activity_report_rebuild.v1"]
    assert client.post("/api/jobs", json={"job_type": "test", "request_id": "r"}).status_code == 422


def test_schema_nine_upgrade_preserves_data_and_backup(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        initialize_database(conn)
        conn.execute("DROP TABLE report_job_items")
        conn.execute("DROP TABLE jobs")
        conn.execute("DROP TABLE job_workers")
        conn.execute("PRAGMA user_version=9")
        conn.execute("INSERT INTO athlete_profiles VALUES ('default','athlete_profile.v1','{}','before','before')")
        conn.execute("""INSERT INTO activities (id,source,sport_type,name,raw_json,created_at,updated_at)
            VALUES ('old-ride','rider-tracker','cycling','Old ride','{}','before','before')""")
        conn.execute("""INSERT INTO saved_routes
            (id,source,name,fingerprint,route_json,total_distance_meters,created_at,updated_at)
            VALUES ('old-route','gpx','Old route','old-fingerprint','{}',1000,'before','before')""")
    root = Path(__file__).resolve().parents[3]
    result = subprocess.run([sys.executable, str(root / "scripts/database-tool.py"), "ensure", "--database", str(path)], capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    assert payload["schema_version"] == SCHEMA_VERSION
    assert payload["startup_action"] == "migrated"
    with sqlite3.connect(payload["backup_path"]) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
        assert conn.execute("SELECT created_at FROM athlete_profiles").fetchone()[0] == "before"
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT created_at FROM athlete_profiles").fetchone()[0] == "before"
        assert conn.execute("SELECT name FROM activities WHERE id='old-ride'").fetchone()[0] == "Old ride"
        assert conn.execute("SELECT name FROM saved_routes WHERE id='old-route'").fetchone()[0] == "Old route"
    second = subprocess.run([sys.executable, str(root / "scripts/database-tool.py"), "ensure", "--database", str(path)], capture_output=True, text=True, check=True)
    assert json.loads(second.stdout)["startup_action"] == "none"
