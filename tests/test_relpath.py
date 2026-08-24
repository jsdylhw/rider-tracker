from __future__ import annotations

from pathlib import Path

from storage.repositories.activity import entry_from_fit_summary


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
