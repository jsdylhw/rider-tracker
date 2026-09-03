from __future__ import annotations

import sqlite3
import time

import pytest

from storage.repositories.activity import ActivityStore, ActivityStoreBusy, entry_from_fit_summary
from storage.database import connect_database


def _v2_report(activity_key: str, fit_path: str) -> dict:
    return {
        "schema_version": "llm_fit_file_analysis.v2",
        "status": "analyzed",
        "activity_key": activity_key,
        "fit_path": fit_path,
        "fit_summary": {
            "sport_type": "cycling",
            "start_time_local": "2026-08-13T08:00:00",
            "duration_s": 1200,
            "distance_m": 8000,
        },
        "activity_metrics": {
            "schema_version": "activity_metrics.v2",
            "power": {"normalized_power_w": 180},
            "load": {"power_stress": {"tss": 20}},
        },
        "analysis_summary": {
            "schema_version": "activity_analysis_summary.v1",
            "summary_label": "晨间骑行",
            "main_stimulus": "有氧",
            "load_label": "低",
        },
        "markdown_report": "# report",
        "strava_summary": "summary",
    }


def test_activity_store_owns_catalogue_and_current_report(tmp_path):
    database = tmp_path / "activities.db"
    fit = tmp_path / "ride.fit"
    fit.write_bytes(b"fit-data")
    store = ActivityStore(database)
    entry = entry_from_fit_summary(
        fit,
        {
            "sport_type": "cycling",
            "start_time_local": "2026-08-13T08:00:00",
            "duration_s": 1200,
            "distance_m": 8000,
        },
    )

    store.upsert_activity(entry)
    report = _v2_report(entry["activity_key"], entry["fit_path"])
    first = store.save_report(report, export_path=tmp_path / "ride.summary.json")
    second = store.save_report(report, export_path=tmp_path / "ride.summary.json")

    assert store.count_activities() == 1
    assert first["revision"] == 1
    assert second["revision"] == 1
    assert store.get_report(entry["activity_key"])["markdown_report"] == "# report"
    activity = store.list_activity_entries()[0]
    assert activity["has_summary"] is True
    assert activity["summary_schema_version"] == "llm_fit_file_analysis.v2"
    assert activity["estimated_tss"] == 20


def test_fit_ingestion_rolls_back_activity_and_facts_when_artifact_write_fails(tmp_path):
    database = tmp_path / "activities.db"
    fit = tmp_path / "failed.fit"
    fit.write_bytes(b"fit-data")
    store = ActivityStore(database)
    entry = entry_from_fit_summary(
        fit,
        {"sport_type": "cycling", "start_time_local": "2026-08-13T08:00:00"},
        activity_key="failed-fit",
    )
    metrics = {"schema_version": "activity_metrics.v2"}
    features = {"schema_version": "activity_features.v1", "extractor_version": "test"}

    with pytest.raises(sqlite3.IntegrityError):
        store.save_fit_ingestion(
            entry,
            metrics=metrics,
            features=features,
            artifact_type=None,
            artifact_schema_version="activity_detail.v1",
            artifact_input_hash="fit-hash",
            artifact_payload={},
        )

    assert store.get_activity("failed-fit") is None
    assert store.get_facts("failed-fit") is None
    assert store.get_artifact("failed-fit", "activity_detail") is None


def test_fit_ingestion_lock_failure_does_not_commit_late(tmp_path):
    database = tmp_path / "activities.db"
    fit = tmp_path / "locked.fit"
    fit.write_bytes(b"fit-data")
    store = ActivityStore(database)
    entry = entry_from_fit_summary(
        fit,
        {"sport_type": "cycling", "start_time_local": "2026-08-13T08:00:00"},
        activity_key="locked-fit",
    )
    locker = connect_database(database)
    locker.execute("BEGIN IMMEDIATE")
    started = time.monotonic()
    try:
        with pytest.raises(ActivityStoreBusy):
            store.save_fit_ingestion(
                entry,
                metrics={"schema_version": "activity_metrics.v2"},
                features={"schema_version": "activity_features.v1", "extractor_version": "test"},
                artifact_type="activity_detail",
                artifact_schema_version="activity_detail.v1",
                artifact_input_hash="fit-hash",
                artifact_payload={},
            )
    finally:
        elapsed = time.monotonic() - started
        locker.rollback()
        locker.close()

    assert elapsed < 2
    assert store.get_activity("locked-fit") is None


def test_report_store_rejects_unindexed_and_legacy_documents(tmp_path):
    database = tmp_path / "activities.db"
    fit = tmp_path / "ride.fit"
    fit.write_bytes(b"fit-data")
    store = ActivityStore(database)
    entry = entry_from_fit_summary(
        fit,
        {"sport_type": "cycling", "start_time_local": "2026-08-13T08:00:00"},
    )
    report = _v2_report(entry["activity_key"], entry["fit_path"])

    import pytest

    with pytest.raises(KeyError, match="indexed"):
        store.save_report(report)
    store.upsert_activity(entry)
    with pytest.raises(ValueError, match="unsupported report schema"):
        store.save_report({**report, "schema_version": "llm_fit_file_analysis.v1"})


def test_garmin_refresh_replaces_old_content_identity_and_report(tmp_path):
    database = tmp_path / "activities.db"
    old_fit = tmp_path / "old-name.fit"
    new_fit = tmp_path / "new-name.fit"
    old_fit.write_bytes(b"old")
    new_fit.write_bytes(b"new")
    store = ActivityStore(database)
    old = entry_from_fit_summary(
        old_fit, {"sport_type": "cycling", "start_time_local": "2026-08-13T08:00:00"},
        source="garmin_cn", source_activity_id="remote-123",
    )
    new = entry_from_fit_summary(
        new_fit, {"sport_type": "cycling", "start_time_local": "2026-08-13T08:00:00"},
        source="garmin_cn", source_activity_id="remote-123",
    )
    store.upsert_activity(old)
    store.save_report(_v2_report(old["activity_key"], old["fit_path"]))

    store.upsert_activity(new)

    assert store.count_activities() == 1
    assert store.get_activity(old["activity_key"]) is None
    assert store.get_report(old["activity_key"]) is None
    assert store.get_activity(new["activity_key"])["source_activity_id"] == "remote-123"


def test_history_uses_v2_report_only_as_legacy_fallback(tmp_path):
    database = tmp_path / "activities.db"
    fit = tmp_path / "ride.fit"
    fit.write_bytes(b"fit-data")
    store = ActivityStore(database)
    entry = entry_from_fit_summary(
        fit,
        {
            "sport_type": "cycling",
            "start_time_local": "2026-08-13T08:00:00",
            "duration_s": 1200,
            "distance_m": 8000,
        },
    )
    store.upsert_activity(entry)
    store.save_report(_v2_report(entry["activity_key"], entry["fit_path"]))

    history = store.query_history(before="2026-08-14T00:00:00", days=7)

    assert history["kind"] == "activity_facts_history"
    assert history["count"] == 1
    assert history["activities"][0]["summary_label"] == "晨间骑行"


def test_rider_activity_library_preserves_paging_filters_and_global_summary(tmp_path):
    database = tmp_path / "activities.db"
    store = ActivityStore(database)
    entries = []
    for index, (sport, source, distance) in enumerate([
        ("cycling", "fit-import", 12_000),
        ("running", "garmin_cn", 5_000),
        ("cycling", "garmin_cn", 20_000),
    ]):
        fit = tmp_path / f"activity-{index}.fit"
        fit.write_bytes(f"fit-{index}".encode())
        entry = entry_from_fit_summary(
            fit,
            {
                "sport_type": sport,
                "start_time_local": f"2026-08-{20 + index}T08:00:00",
                "duration_s": 1200 + index,
                "distance_m": distance,
            },
            source=source,
        )
        store.upsert_activity({**entry, "name": f"Activity {index}", "estimated_tss": 10 + index})
        entries.append(entry)

    history = store.get_rider_history(limit=1, offset=0, sport_type="cycling", source="garmin_cn")

    assert history["page"] == {"total": 1, "offset": 0, "limit": 1, "hasMore": False}
    assert history["activities"][0]["name"] == "Activity 2"
    assert history["activities"][0]["sportType"] == "cycling"
    assert history["summary"]["activityCount"] == 3
    assert history["summary"]["totalDistanceKm"] == 37


def test_rider_activity_library_reads_renames_and_cascade_deletes(tmp_path):
    database = tmp_path / "activities.db"
    fit = tmp_path / "ride.fit"
    fit.write_bytes(b"fit-data")
    store = ActivityStore(database)
    entry = entry_from_fit_summary(
        fit,
        {
            "sport_type": "cycling",
            "start_time_local": "2026-08-13T08:00:00",
            "duration_s": 1200,
            "distance_m": 8000,
        },
    )
    store.upsert_activity({**entry, "name": "Original"})
    store.save_report(_v2_report(entry["activity_key"], entry["fit_path"]))
    with connect_database(database) as connection:
        connection.execute(
            """
            UPDATE activities
            SET saved_route_id = ?, route_start_distance_meters = ?, route_end_distance_meters = ?
            WHERE id = ?
            """,
            ("route-1", 1000, 9000, entry["activity_key"]),
        )

    detail = store.get_rider_activity(entry["activity_key"], include_raw_session=True)
    renamed = store.rename_rider_activity(entry["activity_key"], "Renamed")
    deleted = store.delete_rider_activity(entry["activity_key"])

    assert detail["rawSession"]["activity_key"] == entry["activity_key"]
    assert detail["savedRouteId"] == "route-1"
    assert detail["routeEndDistanceMeters"] == 9000
    assert renamed["name"] == "Renamed"
    assert deleted["id"] == entry["activity_key"]
    assert store.get_rider_activity(entry["activity_key"]) is None
    assert store.get_report(entry["activity_key"]) is None


@pytest.mark.parametrize("operation", ["rename", "delete"])
def test_activity_mutation_fails_before_proxy_deadline_without_late_commit(tmp_path, operation):
    database = tmp_path / "activities.db"
    fit = tmp_path / "ride.fit"
    fit.write_bytes(b"fit-data")
    store = ActivityStore(database)
    entry = entry_from_fit_summary(
        fit,
        {"sport_type": "cycling", "start_time_local": "2026-08-29T08:00:00"},
    )
    store.upsert_activity({**entry, "name": "Original"})

    locker = connect_database(database)
    locker.execute("BEGIN IMMEDIATE")
    started = time.monotonic()
    try:
        with pytest.raises(ActivityStoreBusy):
            if operation == "rename":
                store.rename_rider_activity(entry["activity_key"], "Late rename")
            else:
                store.delete_rider_activity(entry["activity_key"])
    finally:
        elapsed = time.monotonic() - started
        locker.rollback()
        locker.close()

    assert elapsed < 2
    activity = store.get_rider_activity(entry["activity_key"])
    assert activity is not None
    assert activity["name"] == "Original"
