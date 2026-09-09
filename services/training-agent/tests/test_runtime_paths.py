from pathlib import Path

import pytest

from project_paths import DEFAULT_PROJECT_ROOT, project_root, runtime_paths


def test_default_project_root_does_not_follow_process_cwd(tmp_path, monkeypatch):
    monkeypatch.delenv("RIDER_PROJECT_ROOT", raising=False)
    monkeypatch.chdir(tmp_path)

    assert project_root() == DEFAULT_PROJECT_ROOT
    assert runtime_paths(environ={}).project_root == DEFAULT_PROJECT_ROOT


def test_runtime_paths_are_independent_from_process_cwd(tmp_path, monkeypatch):
    project = tmp_path / "rider"
    elsewhere = tmp_path / "elsewhere"
    project.mkdir()
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    paths = runtime_paths(environ={"RIDER_PROJECT_ROOT": str(project)})

    assert paths.project_root == project.resolve()
    assert paths.database == project / "data" / "rider-tracker.db"
    assert paths.fit_root == project / "data" / "files" / "fit"
    assert paths.strava_token_store == project / "data" / "credentials" / "strava-tokens.json"
    assert paths.activity_workflow_dir == project / "data" / "workflows" / "activity-runs"
    assert paths.log_dir == project / "data" / "logs"


def test_runtime_paths_accept_custom_data_root_and_project_relative_overrides(tmp_path):
    project = tmp_path / "rider"
    paths = runtime_paths(environ={
        "RIDER_PROJECT_ROOT": str(project),
        "RIDER_DATA_ROOT": "runtime-data",
        "FIT_FILE_DIR": "external-fit",
    })

    assert paths.data_root == project / "runtime-data"
    assert paths.database == project / "runtime-data" / "rider-tracker.db"
    assert paths.fit_root == project / "external-fit"


def test_runtime_paths_reject_split_database_configuration(tmp_path):
    with pytest.raises(RuntimeError, match="must reference the same database"):
        runtime_paths(environ={
            "RIDER_PROJECT_ROOT": str(tmp_path),
            "RIDER_TRACKER_DB_PATH": "data/rider.db",
            "TRAINING_AGENT_DB_PATH": "data/agent.db",
        })


def test_default_consumers_resolve_environment_at_call_time(tmp_path, monkeypatch):
    project = tmp_path / "runtime-project"
    config = project / "config.yaml"
    config.parent.mkdir(parents=True)
    config.write_text("download_count: 7\n", encoding="utf-8")
    monkeypatch.setenv("RIDER_PROJECT_ROOT", str(project))
    monkeypatch.setenv("RIDER_DATA_ROOT", str(project / "runtime-data"))
    monkeypatch.delenv("TRAINING_AGENT_CONFIG_PATH", raising=False)

    from domain.athlete import load_athlete_profile, save_athlete_profile
    from integrations.strava import StravaSink
    from settings import load_config

    assert load_config()["download_count"] == 7
    saved = save_athlete_profile({"shared": {"weight_kg": 80}})
    assert saved == project / "runtime-data" / "athlete.json"
    assert load_athlete_profile()["shared"]["weight_kg"] == 80
    assert StravaSink(config={}, require_access_token=False).token_store == (
        project / "runtime-data" / "credentials" / "strava-tokens.json"
    )
