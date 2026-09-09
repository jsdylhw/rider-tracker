from __future__ import annotations

from services.activity.session_archive import archive_rider_session, normalize_rider_session
from storage.repositories.activity import ActivityStore, entry_from_fit_summary


def test_normalize_rider_session_preserves_legacy_identity_metrics_and_route():
    activity = normalize_rider_session(_session(), now="2026-08-31T09:00:00+00:00")

    assert activity["id"] == "rt-9b36bad65037334b"
    assert activity["source"] == "rider-tracker"
    assert activity["sport_type"] == "VirtualRide"
    assert activity["name"] == "Test Virtual Ride"
    assert activity["elapsed_seconds"] == 1800
    assert activity["distance_km"] == 12.34
    assert activity["average_power"] == 205
    assert activity["saved_route_id"] == "route-1"
    assert activity["route_start_distance_meters"] == 3200
    assert activity["route_end_distance_meters"] == 15540


def test_archive_rider_session_is_idempotent_and_keeps_raw_records(tmp_path):
    database = tmp_path / "activities.db"
    first = archive_rider_session(_session(), path=database)
    second = archive_rider_session(_session(), name="Renamed fallback", path=database)
    store = ActivityStore(database)

    assert first["id"] == second["id"]
    assert second["name"] == "Renamed fallback"
    assert second["savedRouteId"] == "route-1"
    assert second["rawSession"]["records"] == _session()["records"]
    assert store.count_activities() == 1


def test_session_retry_without_route_keeps_existing_route_link(tmp_path):
    database = tmp_path / "activities.db"
    first = archive_rider_session(_session(), path=database)
    retry = _session()
    retry.pop("route")

    second = archive_rider_session(retry, path=database)

    assert second["savedRouteId"] == first["savedRouteId"] == "route-1"
    assert second["routeStartDistanceMeters"] == first["routeStartDistanceMeters"] == 3200
    assert second["routeEndDistanceMeters"] == first["routeEndDistanceMeters"] == 15540


def test_session_archive_reads_result_inside_write_connection(tmp_path, monkeypatch):
    database = tmp_path / "activities.db"
    store = ActivityStore(database)
    session = _session()
    activity = normalize_rider_session(session)

    monkeypatch.setattr(
        store,
        "get_rider_activity",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unexpected second connection")),
    )

    archived = store.archive_rider_session(activity, raw_session=session)

    assert archived["id"] == activity["id"]
    assert archived["savedRouteId"] == "route-1"


def test_session_retry_does_not_clear_existing_fit_or_report(tmp_path):
    database = tmp_path / "activities.db"
    fit = tmp_path / "ride.fit"
    fit.write_bytes(b"fit-data")
    store = ActivityStore(database)
    session = {**_session(), "activityId": "fit-backed-ride"}
    entry = entry_from_fit_summary(
        fit,
        {"sport_type": "cycling", "start_time_local": session["createdAt"]},
        activity_key="fit-backed-ride",
    )
    store.upsert_activity(entry)
    store.save_report(_report("fit-backed-ride", str(fit)))

    archived = archive_rider_session(session, path=database)

    assert archived["fitFilePath"] == fit.as_posix()
    assert store.get_report("fit-backed-ride") is not None


def _session() -> dict:
    return {
        "createdAt": "2026-04-29T10:00:00.000Z",
        "finishedAt": "2026-04-29T10:30:00.000Z",
        "exportMetadata": {
            "activityName": "Test Virtual Ride",
            "markVirtualActivity": True,
        },
        "route": {
            "savedRouteId": "route-1",
            "continuation": {"startDistanceMeters": 3200},
        },
        "summary": {
            "metrics": {
                "ride": {"elapsedSeconds": 1800, "distanceKm": 12.34, "ascentMeters": 256},
                "power": {"averageWatts": 205, "normalizedPowerWatts": 218},
                "heartRate": {"averageBpm": 146},
                "load": {"estimatedTss": 41.5},
            }
        },
        "records": [
            {"elapsedSeconds": 0, "distanceKm": 0, "power": 190},
            {"elapsedSeconds": 1800, "distanceKm": 12.34, "power": 220},
        ],
    }


def _report(activity_id: str, fit_path: str) -> dict:
    return {
        "schema_version": "llm_fit_file_analysis.v2",
        "activity_key": activity_id,
        "fit_path": fit_path,
        "status": "analyzed",
        "fit_summary": {"sport_type": "cycling"},
        "activity_metrics": {
            "schema_version": "activity_metrics.v2",
            "power": {},
            "load": {},
        },
        "analysis_summary": {
            "schema_version": "activity_analysis_summary.v1",
            "summary_label": "测试活动",
            "main_stimulus": "有氧",
            "load_label": "低",
        },
        "markdown_report": "# 测试活动",
        "strava_summary": "",
    }
