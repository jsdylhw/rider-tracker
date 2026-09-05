"""Real HTTP -> Node -> Python API -> independent worker using temporary data."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

import httpx
import pytest

from storage.database import connect_database
from storage.repositories.job import JobStore


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(operation, predicate=lambda value: bool(value), timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = operation()
            if predicate(value):
                return value
        except (httpx.TransportError, KeyError):
            pass
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for subprocess state")


def test_production_worker_entry_requires_prepared_schema(tmp_path):
    agent_root = Path(__file__).resolve().parents[1]
    env = {**os.environ, "PYTHONPATH": str(agent_root)}
    # It may create an empty SQLite file but must never initialize schema itself.
    result = subprocess.run([sys.executable, "-m", "worker.main"], cwd=agent_root,
                            env=env, capture_output=True, timeout=10)
    assert result.returncode != 0
    connect_database().close()
    child = subprocess.Popen([sys.executable, "-m", "worker.main"], cwd=agent_root,
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for(lambda: JobStore().availability(), lambda value: value["worker"] == "available")
        assert child.poll() is None
        assert JobStore().availability()["job_types"] == ["activity_report_rebuild.v1"]
    finally:
        child.kill()
        child.wait(timeout=5)


def test_unified_launcher_starts_api_and_worker_without_ai(tmp_path):
    if not shutil.which("node"):
        pytest.skip("Node is required for launcher integration")
    root = Path(__file__).resolve().parents[3]
    api_port, node_port = port(), port()
    config = tmp_path / "config.yaml"
    config.write_text("agent:\n  enabled: false\n", encoding="utf-8")
    env = {**os.environ, "RIDER_CONFIG_PATH": str(config), "RIDER_OPEN_BROWSER": "false",
           "PYTHON_EXECUTABLE": sys.executable, "PERSONAL_FIT_AGENT_URL": f"http://127.0.0.1:{api_port}",
           "PERSONAL_FIT_AGENT_TOKEN": "", "HOST": "127.0.0.1", "PORT": str(node_port),
           "APP_BASE_URL": f"http://127.0.0.1:{node_port}"}
    supervisor = """
        const { fork } = require('node:child_process');
        const child = fork(process.argv[1], [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        process.stdin.resume();
        process.stdin.on('end', () => { if (child.connected) child.disconnect(); });
        child.on('exit', code => process.exit(code || 0));
    """
    child = subprocess.Popen(["node", "-e", supervisor, str(root / "scripts/start-local.js")], cwd=root, env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{node_port}", timeout=3, trust_env=False) as client:
            ready = wait_for(lambda: client.get("/api/jobs/capabilities").json(),
                             lambda data: data.get("worker") == "available", timeout=25)
            assert ready["supported_job_types"] == ["activity_report_rebuild.v1"]
            assert client.get("/api/activities").status_code == 200
            assert client.get("/healthz").status_code == 200
    finally:
        # Closing the supervisor's stdin disconnects IPC; the launcher closes its own children.
        child.communicate(input=b"", timeout=10)


def test_real_gateway_worker_crash_recovery_cancel_and_api_restart(tmp_path):
    if not shutil.which("node"):
        pytest.skip("Node is required for gateway integration")
    agent_root = Path(__file__).resolve().parents[1]
    root = agent_root.parents[1]
    api_port, node_port = port(), port()
    fixture = Path(__file__).with_name("job_process_fixture.py")
    connect_database().close()
    env = {**os.environ, "TRAINING_AGENT_MANAGED_DATABASE": "1", "PYTHONPATH": str(agent_root),
           "PERSONAL_FIT_AGENT_URL": f"http://127.0.0.1:{api_port}", "PERSONAL_FIT_AGENT_TOKEN": "fixture-token",
           "HOST": "127.0.0.1", "PORT": str(node_port), "APP_BASE_URL": f"http://127.0.0.1:{node_port}"}
    processes = []
    def start(args):
        child = subprocess.Popen(args, cwd=agent_root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(child)
        return child
    def stop(child):
        child.kill()
        child.wait(timeout=5)
    try:
        api = start([sys.executable, str(fixture), "api", str(api_port)])
        start(["node", str(root / "src/server/index.js")])
        client = httpx.Client(base_url=f"http://127.0.0.1:{node_port}", timeout=3, trust_env=False)
        with client:
            wait_for(lambda: client.get("/api/jobs/capabilities"), lambda r: r.status_code == 200)
            assert client.post("/api/jobs", headers={"Origin": "https://evil.invalid"}, json={}).status_code == 403
            request = {"job_type": "test", "request_id": "recover", "payload": {"steps": 30}}
            submitted = client.post("/api/jobs", json=request)
            assert submitted.status_code == 202
            job_id = submitted.json()["job_id"]
            assert client.post("/api/jobs", json=request).json()["job_id"] == job_id
            conflict = client.post("/api/jobs", json={**request, "payload": {"steps": 1}})
            assert conflict.status_code == 409 and conflict.json()["code"] == "request_conflict"
            one = start([sys.executable, str(fixture), "worker"])
            wait_for(lambda: client.get(f"/api/jobs/{job_id}").json(), lambda j: j.get("status") == "running")
            stop(one)
            assert client.get("/healthz").status_code == 200
            assert client.get(f"/api/jobs/{job_id}").status_code == 200
            stop(api)
            start([sys.executable, str(fixture), "api", str(api_port)])
            wait_for(lambda: client.get(f"/api/jobs/{job_id}"), lambda r: r.status_code == 200)
            two = start([sys.executable, str(fixture), "worker"])
            three = start([sys.executable, str(fixture), "worker"])
            done = wait_for(lambda: client.get(f"/api/jobs/{job_id}").json(), lambda j: j.get("status") == "succeeded")
            assert done["result_ref"] == {"fixture": "done"}
            with JobStore()._connection() as conn:
                assert conn.execute("SELECT attempt FROM jobs WHERE job_id=?", (job_id,)).fetchone()[0] == 2
            cancel_id = client.post("/api/jobs", json={**request, "request_id": "cancel", "payload": {"steps": 100}}).json()["job_id"]
            wait_for(lambda: client.get(f"/api/jobs/{cancel_id}").json(), lambda j: j.get("status") == "running")
            assert client.post(f"/api/jobs/{cancel_id}/cancel").status_code == 200
            wait_for(lambda: client.get(f"/api/jobs/{cancel_id}").json(), lambda j: j.get("status") == "cancelled")
            stop(two)
            stop(three)
    finally:
        for child in processes:
            if child.poll() is None:
                stop(child)


def test_report_job_process_recovery_skips_saved_reports(tmp_path):
    if not shutil.which("node"):
        pytest.skip("Node is required for gateway integration")
    from storage.repositories.activity import ActivityStore
    agent_root = Path(__file__).resolve().parents[1]
    root = agent_root.parents[1]
    fixture = Path(__file__).with_name("job_process_fixture.py")
    store = ActivityStore()
    for index in range(3):
        fit = tmp_path / f"ride-{index}.fit"
        fit.write_bytes(f"fit-{index}".encode())
        store.upsert_activity({"activity_key": f"stable-{index}", "fit_path": str(fit)})
    api_port, node_port = port(), port()
    calls = tmp_path / "calls.txt"
    env = {**os.environ, "TRAINING_AGENT_MANAGED_DATABASE": "1", "PYTHONPATH": str(agent_root),
           "PERSONAL_FIT_AGENT_URL": f"http://127.0.0.1:{api_port}", "PERSONAL_FIT_AGENT_TOKEN": "fixture-token",
           "HOST": "127.0.0.1", "PORT": str(node_port), "APP_BASE_URL": f"http://127.0.0.1:{node_port}",
           "REPORT_TEST_CALLS": str(calls)}
    children = []
    def start(args):
        process = subprocess.Popen(args, cwd=agent_root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        children.append(process)
        return process
    def stop(process):
        process.kill()
        process.wait(timeout=5)
    try:
        api = start([sys.executable, str(fixture), "api", str(api_port)])
        start(["node", str(root / "src/server/index.js")])
        with httpx.Client(base_url=f"http://127.0.0.1:{node_port}", timeout=3, trust_env=False) as client:
            wait_for(lambda: client.get("/api/jobs/capabilities"), lambda value: value.status_code == 200)
            body = {"job_type": "activity_report_rebuild.v1", "request_id": "reports", "payload": {"scope": "all"}}
            submitted = client.post("/api/jobs", json=body)
            assert submitted.status_code == 202
            job_id = submitted.json()["job_id"]
            detail_url = f"/api/jobs/{job_id}/report-rebuild"
            first = start([sys.executable, str(fixture), "report-worker"])
            wait_for(lambda: client.get(detail_url).json(), lambda value: value.get("completed") == 1)
            stop(first)
            stop(api)
            start([sys.executable, str(fixture), "api", str(api_port)])
            restored = wait_for(lambda: client.get(detail_url).json(), lambda value: value.get("completed") == 1)
            assert restored["total"] == 3
            start([sys.executable, str(fixture), "report-worker"])
            done = wait_for(lambda: client.get(detail_url).json(), lambda value: value.get("status") == "completed", timeout=20)
            assert done["completed"] == 3 and done["failed"] == 0
            assert calls.read_text().splitlines().count("stable-0") == 1
            assert store.get_report_record("stable-0")["revision"] == 1
            assert client.post("/api/jobs", json=body).json()["job_id"] == job_id
            assert "fit_path" not in client.get(detail_url).text
            cancel = client.post("/api/jobs", json={**body, "request_id": "cancel", "payload": {"activity_keys": ["stable-2"]}}).json()
            cancel_id = cancel["job_id"]
            wait_for(lambda: client.get(f"/api/jobs/{cancel_id}").json(), lambda value: value.get("status") == "running")
            client.post(f"/api/jobs/{cancel_id}/cancel")
            wait_for(lambda: client.get(f"/api/jobs/{cancel_id}").json(), lambda value: value.get("status") == "cancelled")
            assert store.get_report_record("stable-2")["revision"] == 1
            assert client.get("/healthz").status_code == 200
    finally:
        for process in children:
            if process.poll() is None:
                stop(process)
