"""Offline doctor regression tests; fixtures contain no user data."""
import importlib.util
import json
from pathlib import Path
import socket

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("rider_doctor", ROOT / "scripts/doctor.py")
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)


@pytest.fixture
def root(tmp_path):
    agent = tmp_path / "services/training-agent"
    agent.mkdir(parents=True)
    (agent / "pyproject.toml").write_text('[project]\nrequires-python=">=3.12"\ndependencies=["garminconnect==0.3.6"]\n', encoding="utf-8")
    return tmp_path


def check(report, id):
    return next(item for item in report["checks"] if item["id"] == id)


def test_missing_and_wrong_dependency(root, monkeypatch):
    checks = []
    add = lambda id, status, message: checks.append(dict(id=id, status=status, message=message))
    monkeypatch.setattr(doctor.metadata, "version", lambda name: "0.3.3")
    doctor.check_dependencies(root, add)
    assert check({"checks": checks}, "dependency:garminconnect")["status"] == "error"
    def missing(name):
        raise doctor.metadata.PackageNotFoundError(name)
    monkeypatch.setattr(doctor.metadata, "version", missing)
    checks.clear()
    doctor.check_dependencies(root, add)
    assert "Not installed" in check({"checks": checks}, "dependency:garminconnect")["message"]


def test_configuration_errors_do_not_expose_source(root):
    (root / "config.yaml").write_text('agent: [sentinel-private-api-key\n', encoding="utf-8")
    report = doctor.diagnose(root, {})
    assert not report["ok"]
    assert check(report, "config")["status"] == "error"
    assert "sentinel-private-api-key" not in json.dumps(report)


def test_divergent_database_paths_fail_without_creating_data(root):
    report = doctor.diagnose(root, {"RIDER_TRACKER_DB_PATH": "one.db", "TRAINING_AGENT_DB_PATH": "two.db"})
    assert check(report, "database-path")["status"] == "error"
    assert not (root / "data").exists()
    assert not (root / "one.db").exists()


def test_port_occupied_is_warning_and_bad_port_is_error():
    checks = []
    add = lambda id, status, message: checks.append(dict(id=id, status=status, message=message))
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        doctor.check_port({"HOST": "127.0.0.1", "PORT": str(listener.getsockname()[1])}, add)
    assert checks[-1]["status"] == "warning"
    doctor.check_port({"PORT": "invalid-secret-value"}, add)
    assert checks[-1]["status"] == "error"
    assert "invalid-secret-value" not in checks[-1]["message"]


def test_readable_config_does_not_leak_credentials_or_create_data(root, monkeypatch):
    (root / "config.yaml").write_text('agent:\n  api_key: sentinel-private-key\ngarmin:\n  password: sentinel-private-password\n', encoding="utf-8")
    monkeypatch.setattr(doctor.metadata, "version", lambda name: "0.3.6")
    report = doctor.diagnose(root, {})
    assert report["ok"]
    assert "sentinel-private" not in json.dumps(report)
    assert check(report, "database-path")["status"] == "ok"
    assert not (root / "data").exists()


def test_directory_replaced_with_file_is_error(root):
    (root / "data").write_text("not a directory", encoding="utf-8")
    report = doctor.diagnose(root, {})
    assert check(report, "path:data_root")["status"] == "error"


def test_node_version_uses_package_requirement(root, monkeypatch):
    (root / "package.json").write_text('{"engines":{"node":">=24"}}', encoding="utf-8")
    monkeypatch.setattr(doctor.metadata, "version", lambda name: "0.3.6")
    report = doctor.diagnose(root, {"RIDER_DOCTOR_NODE_VERSION": "22.0.0"})
    assert check(report, "node")["status"] == "error"
