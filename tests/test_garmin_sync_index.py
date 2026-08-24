from __future__ import annotations

from pathlib import Path

from operations.activity.service import sync_garmin_activities_tool
from services.activity.catalog import list_activities


def test_sync_garmin_indexes_downloaded_fit(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)

    activity = {
        "activityId": 123,
        "activityName": "基础训练",
        "startTimeLocal": "2026-05-26 21:38:30",
    }

    class FakeDownloader:
        def login(self):
            return None

        def list_activities(self, count):
            return [activity]

        def download_original(self, activity_id):
            return b"fake-fit"

    monkeypatch.setattr("settings.load_config", lambda: {"output_dir": "fits"})
    monkeypatch.setattr("settings.cfg_get", lambda config, key, default=None: config.get(key, default))
    monkeypatch.setattr("integrations.garmin.build_downloader", lambda config: FakeDownloader())
    monkeypatch.setattr("integrations.garmin.existing_fit_paths", lambda output_dir, item: [])
    monkeypatch.setattr(
        "services.activity.catalog.parse_fit",
        lambda path: {
            "summary": {
                "sport_type": "running",
                "sub_sport": "generic",
                "start_time_local": "2026-05-26T21:38:30",
                "duration_s": 1800,
                "distance_m": 5000,
            }
        },
    )

    result = sync_garmin_activities_tool(count=1)

    assert result["downloaded"] == 1
    assert result["indexed"] == 1
    assert result["index_errors"] == []

    activities = list_activities(limit=1)
    assert activities["count"] == 1
    assert activities["activities"][0]["sport_type"] == "running"
    assert activities["activities"][0]["source"] == "garmin_cn"
    assert Path(activities["activities"][0]["fit_path"]).exists()


def test_sync_garmin_indexes_existing_fit(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    fit_dir = tmp_path / "fits"
    fit_dir.mkdir()
    fit_path = fit_dir / "existing.fit"
    fit_path.write_bytes(b"fake-fit")

    activity = {
        "activityId": 456,
        "activityName": "基础训练",
        "startTimeLocal": "2026-05-26 21:38:30",
    }

    class FakeDownloader:
        def login(self):
            return None

        def list_activities(self, count):
            return [activity]

        def download_original(self, activity_id):
            raise AssertionError("existing FIT should not be downloaded")

    monkeypatch.setattr("settings.load_config", lambda: {"output_dir": str(fit_dir)})
    monkeypatch.setattr("settings.cfg_get", lambda config, key, default=None: config.get(key, default))
    monkeypatch.setattr("integrations.garmin.build_downloader", lambda config: FakeDownloader())
    monkeypatch.setattr("integrations.garmin.existing_fit_paths", lambda output_dir, item: [fit_path])
    monkeypatch.setattr(
        "services.activity.catalog.parse_fit",
        lambda path: {
            "summary": {
                "sport_type": "running",
                "start_time_local": "2026-05-26T21:38:30",
                "duration_s": 1200,
                "distance_m": 3000,
            }
        },
    )

    result = sync_garmin_activities_tool(count=1)

    assert result["downloaded"] == 0
    assert result["skipped"] == 1
    assert result["indexed"] == 1
    assert list_activities(limit=1)["activities"][0]["sport_type"] == "running"


def test_sync_garmin_force_download_refreshes_existing_fit(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    fit_dir = tmp_path / "fits"
    fit_dir.mkdir()
    fit_path = fit_dir / "existing.fit"
    fit_path.write_bytes(b"old-fit")
    activity = {
        "activityId": 456,
        "activityName": "基础训练",
        "startTimeLocal": "2026-05-26 21:38:30",
    }
    downloads = []

    class FakeDownloader:
        def login(self):
            return None

        def list_activities(self, count):
            return [activity]

        def download_original(self, activity_id):
            downloads.append(activity_id)
            return b"new-fit"

    monkeypatch.setattr("settings.load_config", lambda: {"output_dir": str(fit_dir)})
    monkeypatch.setattr("settings.cfg_get", lambda config, key, default=None: config.get(key, default))
    monkeypatch.setattr("integrations.garmin.build_downloader", lambda config: FakeDownloader())
    monkeypatch.setattr("integrations.garmin.existing_fit_paths", lambda output_dir, item: [fit_path])
    monkeypatch.setattr("integrations.garmin.save_original_as_fit", lambda raw, output_dir, item: [fit_path])
    monkeypatch.setattr(
        "services.activity.catalog.parse_fit",
        lambda path: {"summary": {"sport_type": "cycling", "start_time_local": "2026-05-26T21:38:30"}},
    )

    result = sync_garmin_activities_tool(count=1, force_download=True)

    assert downloads == [456]
    assert result["downloaded"] == 1
    assert result["skipped"] == 0
    assert result["force_download"] is True


def test_force_download_keeps_existing_fit_when_staged_parse_fails(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    fit_dir = tmp_path / "fits"
    fit_dir.mkdir()
    activity = {
        "activityId": 456,
        "activityName": "基础训练",
        "startTimeLocal": "2026-05-26 21:38:30",
    }
    from integrations.garmin import activity_base_name
    fit_path = fit_dir / f"{activity_base_name(activity)}.fit"
    fit_path.write_bytes(b"old-valid-fit")

    class FakeDownloader:
        def login(self):
            return None

        def list_activities(self, count):
            return [activity]

        def download_original(self, activity_id):
            return b"new-invalid-fit"

    monkeypatch.setattr("settings.load_config", lambda: {"output_dir": str(fit_dir)})
    monkeypatch.setattr("settings.cfg_get", lambda config, key, default=None: config.get(key, default))
    monkeypatch.setattr("integrations.garmin.build_downloader", lambda config: FakeDownloader())
    monkeypatch.setattr("services.activity.catalog.parse_fit", lambda path: (_ for _ in ()).throw(ValueError("bad FIT")))

    result = sync_garmin_activities_tool(count=1, force_download=True)

    assert result["failed"] == 1
    assert result["downloaded"] == 0
    assert fit_path.read_bytes() == b"old-valid-fit"


def test_sync_garmin_continues_after_one_activity_download_fails(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    activities = [
        {"activityId": 1, "activityName": "失败活动", "startTimeLocal": "2026-05-26 08:00:00"},
        {"activityId": 2, "activityName": "成功活动", "startTimeLocal": "2026-05-26 09:00:00"},
    ]

    class FakeDownloader:
        def login(self):
            return None

        def list_activities(self, count):
            return activities

        def download_original(self, activity_id):
            if activity_id == 1:
                raise ConnectionError("temporary Garmin failure")
            return b"fake-fit"

    monkeypatch.setattr("settings.load_config", lambda: {"output_dir": "fits"})
    monkeypatch.setattr("settings.cfg_get", lambda config, key, default=None: config.get(key, default))
    monkeypatch.setattr("integrations.garmin.build_downloader", lambda config: FakeDownloader())
    monkeypatch.setattr("integrations.garmin.existing_fit_paths", lambda output_dir, item: [])
    monkeypatch.setattr(
        "services.activity.catalog.parse_fit",
        lambda path: {"summary": {"sport_type": "cycling", "start_time_local": "2026-05-26T09:00:00"}},
    )

    result = sync_garmin_activities_tool(count=2)

    assert result["downloaded"] == 1
    assert result["failed"] == 1
    assert result["failed_items"][0]["activity_id"] == 1
    assert result["failed_items"][0]["error"] == "ConnectionError"
