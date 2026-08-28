import json

import pytest

from project_paths import runtime_paths
from runtime_data_migration import audit_runtime_data, migrate_runtime_data


def _paths(tmp_path):
    return runtime_paths(environ={"RIDER_PROJECT_ROOT": str(tmp_path)})


def test_audit_reports_legacy_files_and_never_writes(tmp_path):
    token = tmp_path / "data" / "strava-tokens.json"
    run = tmp_path / "services" / "training-agent" / "data" / "activity_runs" / "run-1.json"
    token.parent.mkdir(parents=True)
    run.parent.mkdir(parents=True)
    token.write_text('{"access_token":"secret"}', encoding="utf-8")
    run.write_text("{}", encoding="utf-8")

    result = audit_runtime_data(_paths(tmp_path))

    assert result["status"] == "ready"
    assert result["summary"]["copy"] == 2
    assert not (tmp_path / "data" / "credentials" / "strava-tokens.json").exists()
    assert not (tmp_path / "data" / "migrations").exists()


def test_migration_copies_verifies_and_is_idempotent(tmp_path):
    source = tmp_path / "services" / "training-agent" / "log" / "turn.md"
    source.parent.mkdir(parents=True)
    source.write_text("turn", encoding="utf-8")
    paths = _paths(tmp_path)

    completed = migrate_runtime_data(paths)
    repeated = migrate_runtime_data(paths)

    target = tmp_path / "data" / "logs" / "turn.md"
    assert completed["status"] == "completed"
    assert target.read_text(encoding="utf-8") == "turn"
    assert source.exists(), "copy-first migration must retain legacy source files"
    assert repeated["status"] == "already_applied"
    manifest = json.loads((paths.migration_dir / "runtime-path-v1.json").read_text(encoding="utf-8"))
    assert manifest["source_files_retained"] is True


def test_migration_fails_closed_before_copying_any_conflict(tmp_path):
    source_token = tmp_path / "data" / "strava-tokens.json"
    target_token = tmp_path / "data" / "credentials" / "strava-tokens.json"
    source_log = tmp_path / "log" / "turn.md"
    source_token.parent.mkdir(parents=True)
    target_token.parent.mkdir(parents=True)
    source_log.parent.mkdir(parents=True)
    source_token.write_text("old", encoding="utf-8")
    target_token.write_text("different", encoding="utf-8")
    source_log.write_text("must-not-copy", encoding="utf-8")

    with pytest.raises(RuntimeError, match="has conflicts"):
        migrate_runtime_data(_paths(tmp_path))

    assert not (tmp_path / "data" / "logs" / "turn.md").exists()


def test_two_different_legacy_tokens_conflict_before_target_exists(tmp_path):
    root_token = tmp_path / "data" / "strava-tokens.json"
    agent_token = tmp_path / "services" / "training-agent" / "data" / "strava-tokens.json"
    root_token.parent.mkdir(parents=True)
    agent_token.parent.mkdir(parents=True)
    root_token.write_text("root", encoding="utf-8")
    agent_token.write_text("agent", encoding="utf-8")

    result = audit_runtime_data(_paths(tmp_path))

    assert result["status"] == "conflict"
    assert result["summary"]["conflict"] == 2


def test_legacy_databases_are_reported_for_manual_review_only(tmp_path):
    database = tmp_path / "services" / "training-agent" / "data" / "personal-fit-agent.db"
    database.parent.mkdir(parents=True)
    database.write_bytes(b"legacy")

    result = audit_runtime_data(_paths(tmp_path))

    assert result["manual_review"][0]["path"] == str(database.resolve())
    assert result["summary"]["copy"] == 0
