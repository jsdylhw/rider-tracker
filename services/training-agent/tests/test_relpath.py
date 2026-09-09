from __future__ import annotations

from pathlib import Path
import sqlite3

import pytest

from project_paths import project_relative_or_absolute, resolve_project_path
from storage.repositories.activity import ActivityStore, entry_from_fit_summary


def test_fit_path_is_project_relative_inside_workspace(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    fit_dir = tmp_path / "garmin_cn_fit_files"
    fit_dir.mkdir()
    fit_file = fit_dir / "test_activity.fit"
    fit_file.write_bytes(b"dummy fit content")

    entry = entry_from_fit_summary(
        fit_file.resolve(),
        {
            "sport_type": "cycling",
            "start_time_local": "2026-05-14T08:00:00",
            "duration_s": 600.0,
            "distance_m": 5000.0,
        },
    )

    assert entry["fit_path"] == "garmin_cn_fit_files/test_activity.fit"
    assert not Path(entry["fit_path"]).is_absolute()
    assert "summary_path" not in entry


@pytest.mark.parametrize("value", ["data/files/fit/骑行.fit", r"data\files\fit\骑行.fit", r"data/files\fit/骑行.fit"])
def test_portable_and_legacy_paths_resolve_from_project_root(tmp_path, monkeypatch, value):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    expected = tmp_path / "data" / "files" / "fit" / "骑行.fit"
    assert resolve_project_path(value) == expected
    assert project_relative_or_absolute(value) == "data/files/fit/骑行.fit"
    assert resolve_project_path(project_relative_or_absolute(expected)) == expected


def test_outside_project_keeps_absolute_path(tmp_path):
    outside = tmp_path / "outside.fit"
    assert project_relative_or_absolute(outside, base=tmp_path / "project") == outside.as_posix()


def test_legacy_windows_paths_are_found_and_normalized_on_write(tmp_path):
    database = tmp_path / "activities.db"
    store = ActivityStore(database)
    store.upsert_activity({"activity_key": "old", "fit_path": "data/files/fit/ride.fit"})
    # Simulate a database written before portable path serialization existed.
    with sqlite3.connect(database) as conn:
        conn.execute("UPDATE activities SET fit_file_path=? WHERE id='old'", (r"data\files\fit\ride.fit",))
    assert store.get_activity_by_fit_path("data/files/fit/ride.fit")["activity_key"] == "old"
    assert store.find_activity_identity(fit_path=str(tmp_path / "data/files/fit/ride.fit"))["activity_key"] == "old"
    # An intentional replacement still respects one FIT path -> one source row.
    stored = store.upsert_activity({"activity_key": "new", "fit_path": "data/files/fit/ride.fit"})
    assert stored["fit_path"] == "data/files/fit/ride.fit"
    assert store.count_activities() == 1
    assert store.get_activity("old") is None


def test_new_windows_style_entry_is_stored_portably(tmp_path):
    store = ActivityStore(tmp_path / "activities.db")
    entry = store.upsert_activity({"activity_key": "one", "fit_path": r"data\files\fit\ride.fit"})
    assert entry["fit_path"] == "data/files/fit/ride.fit"
    assert store.get_activity_by_fit_path(r"data\files\fit\ride.fit")["activity_key"] == "one"
