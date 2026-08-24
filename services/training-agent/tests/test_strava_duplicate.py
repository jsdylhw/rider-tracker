from __future__ import annotations

from unittest.mock import patch

from storage.repositories.activity import ActivityStore
from operations.activity.strava import (
    _parse_duplicate_activity_id,
    upload_activity_to_strava,
    upload_stored_activity_fit,
)


def _stored_activity(tmp_path, *, strava_activity_id: str | None = None) -> tuple[ActivityStore, str]:
    fit = tmp_path / "ride.fit"
    fit.write_bytes(b"fit")
    store = ActivityStore()
    key = "abc123"
    store.upsert_activity({
        "activity_key": key,
        "fit_path": str(fit),
        "sport_type": "cycling",
        "source": "test",
        "strava_activity_id": strava_activity_id,
    })
    store.save_report({
        "schema_version": "llm_fit_file_analysis.v2",
        "status": "analyzed",
        "activity_key": key,
        "fit_path": str(fit),
        "fit_summary": {"sport_type": "cycling", "start_time_local": "2026-05-14T08:00:00"},
        "activity_metrics": {"schema_version": "activity_metrics.v2"},
        "analysis_summary": {"schema_version": "activity_analysis_summary.v1"},
        "markdown_report": "# report",
        "strava_summary": "测试 Strava 总结",
    })
    return store, key


def test_extracts_activity_id_from_duplicate_error():
    status = {
        "error": 'ride.fit duplicate of <a href="/activities/18619000064">Ride</a>',
    }
    assert _parse_duplicate_activity_id(status) == "18619000064"
    assert _parse_duplicate_activity_id({"error": "other"}) is None


def test_duplicate_is_persisted_to_database(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    store, key = _stored_activity(tmp_path)
    with patch("operations.activity.strava.StravaSink") as sink_class:
        sink = sink_class.return_value
        sink.upload_fit.return_value = {"id": 12345}
        sink.wait_for_upload.return_value = {
            "error": 'ride.fit duplicate of <a href="/activities/18619000064">Ride</a>',
        }
        result = upload_activity_to_strava(key)

    assert result["status"] == "duplicate"
    assert result["strava_activity_id"] == "18619000064"
    assert store.get_activity(key)["strava_activity_id"] == "18619000064"
    assert store.get_report(key)["strava_activity_id"] == "18619000064"


def test_force_with_known_id_updates_without_upload(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _, key = _stored_activity(tmp_path, strava_activity_id="18619000064")
    with patch("operations.activity.strava.StravaSink") as sink_class:
        sink = sink_class.return_value
        sink.update_description.return_value = {"id": 18619000064}
        result = upload_activity_to_strava(key, force=True)

    assert result["status"] == "description_updated"
    sink.upload_fit.assert_not_called()
    sink.update_description.assert_called_once_with("18619000064", "测试 Strava 总结")


def test_normal_upload_persists_remote_id(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    store, key = _stored_activity(tmp_path)
    with patch("operations.activity.strava.StravaSink") as sink_class:
        sink = sink_class.return_value
        sink.upload_fit.return_value = {"id": 12345}
        sink.wait_for_upload.return_value = {"activity_id": 98765, "status": "ready"}
        result = upload_activity_to_strava(key)

    assert result["upload_status"]["activity_id"] == 98765
    assert store.get_activity(key)["strava_activity_id"] == "98765"


def test_stored_activity_upload_does_not_require_report_generation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    fit = tmp_path / "ride.fit"
    fit.write_bytes(b"fit")
    ActivityStore().upsert_activity({
        "activity_key": "rider-1",
        "fit_path": str(fit),
        "sport_type": "cycling",
        "source": "rider-tracker",
        "name": "Rider Session",
    })
    with patch("operations.activity.strava.StravaSink") as sink_class:
        sink_class.return_value.upload_fit.return_value = {"id": 123}
        result = upload_stored_activity_fit(
            "rider-1", description="manual", trainer=True, sport_type="VirtualRide",
        )

    assert result["upload"]["id"] == 123
    sink_class.return_value.upload_fit.assert_called_once_with(
        str(fit),
        title="Rider Session",
        description="manual",
        trainer=True,
        commute=False,
        external_id="rider-1",
        sport_type="VirtualRide",
    )
