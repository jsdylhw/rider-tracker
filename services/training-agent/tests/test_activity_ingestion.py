from __future__ import annotations

import pytest
import sqlite3

from services.activity.ingestion import get_activity_detail, ingest_fit_activity
from storage.repositories.activity import ActivityStore
from storage.repositories.saved_route import SavedRouteStore


@pytest.mark.parametrize("legacy_separator", [False, True])
def test_ingestion_reuses_existing_rider_identity_and_caches_detail(
    monkeypatch, tmp_path, sample_parsed_fit, legacy_separator,
):
    monkeypatch.setenv("RIDER_PROJECT_ROOT", str(tmp_path))
    database = tmp_path / "activities.db"
    fit = tmp_path / "data" / "files" / "fit" / "ride.fit"
    fit.parent.mkdir(parents=True)
    fit.write_bytes(b"stable-fit")
    store = ActivityStore(database)
    store.upsert_activity({
        "activity_key": "rt-existing",
        "fit_path": "data/files/fit/ride.fit",
        "source": "rider-tracker",
        "sport_type": "VirtualRide",
        "name": "保留名称",
    })
    if legacy_separator:
        with sqlite3.connect(database) as conn:
            conn.execute("UPDATE activities SET fit_file_path=? WHERE id='rt-existing'", (r"data\files\fit\ride.fit",))
    monkeypatch.setattr("services.activity.ingestion.parse_fit", lambda _path: sample_parsed_fit)

    result = ingest_fit_activity(
        fit,
        source="rider-tracker",
        path=database,
        max_points=20,
    )

    assert result["activity"]["activity_key"] == "rt-existing"
    assert result["activity"]["name"] == "保留名称"
    assert store.count_activities() == 1
    artifact = store.get_artifact("rt-existing", "activity_detail")
    assert artifact["schema_version"] == "activity_detail.v1"
    assert artifact["payload"]["series"]["sample_count"] <= 20
    cached = get_activity_detail("rt-existing", max_points=20, path=database)
    assert cached["series"] == artifact["payload"]["series"]
    assert cached["activity"]["name"] == "保留名称"
    assert cached["report"] is None

    store.save_report({
        "schema_version": "llm_fit_file_analysis.v2",
        "status": "analyzed",
        "activity_key": "rt-existing",
        "activity_metrics": {"schema_version": "activity_metrics.v2"},
        "analysis_summary": {"schema_version": "activity_analysis_summary.v1"},
        "markdown_report": "# 新生成的报告\n\n保持有氧训练。",
        "strava_summary": "保持有氧训练。",
    })
    with_report = get_activity_detail("rt-existing", max_points=20, path=database)
    assert with_report["report"]["markdown_report"].startswith("# 新生成的报告")
    assert with_report["report"]["revision"] == 1
    assert "report" not in store.get_artifact("rt-existing", "activity_detail")["payload"]

    store.upsert_activity({
        **cached["activity"],
        "activity_key": "rt-existing",
        "fit_path": "data/files/fit/ride.fit",
        "name": "新名称",
    })
    assert get_activity_detail("rt-existing", max_points=20, path=database)["activity"]["name"] == "新名称"


def test_ingestion_honors_explicit_activity_id(monkeypatch, tmp_path, sample_parsed_fit):
    monkeypatch.setenv("RIDER_PROJECT_ROOT", str(tmp_path))
    database = tmp_path / "activities.db"
    fit = tmp_path / "data" / "files" / "fit" / "manual.fit"
    fit.parent.mkdir(parents=True)
    fit.write_bytes(b"manual-fit")
    monkeypatch.setattr("services.activity.ingestion.parse_fit", lambda _path: sample_parsed_fit)

    result = ingest_fit_activity(
        fit, activity_key="fit-manual", source="fit-import", path=database,
    )

    assert result["activity"]["activity_key"] == "fit-manual"
    assert result["activity"]["facts_schema_version"] == "activity_features.v1"
    assert result["activity"]["facts_revision"] == 1
    assert ActivityStore(database).get_activity("fit-manual") is not None


def test_ingestion_atomically_links_route_and_preserves_it_on_retry(
    monkeypatch, tmp_path, sample_parsed_fit,
):
    monkeypatch.setenv("RIDER_PROJECT_ROOT", str(tmp_path))
    database = tmp_path / "activities.db"
    fit = tmp_path / "data" / "files" / "fit" / "route.fit"
    fit.parent.mkdir(parents=True)
    fit.write_bytes(b"route-fit")
    route = SavedRouteStore(database).save_route({
        "source": "gpx",
        "name": "Route",
        "route": {
            "source": "gpx",
            "name": "Route",
            "totalDistanceMeters": 20_000,
            "points": [
                {"latitude": 31.0, "longitude": 121.0},
                {"latitude": 31.1, "longitude": 121.1},
            ],
        },
    })
    monkeypatch.setattr("services.activity.ingestion.parse_fit", lambda _path: sample_parsed_fit)

    first = ingest_fit_activity(
        fit,
        activity_key="fit-route",
        source="rider-tracker",
        route_link={
            "saved_route_id": route["id"],
            "start_distance_meters": 3_200,
            "end_distance_meters": 15_540,
        },
        path=database,
    )
    second = ingest_fit_activity(fit, activity_key="fit-route", path=database)

    assert first["rider_activity"]["savedRouteId"] == route["id"]
    assert first["rider_activity"]["routeStartDistanceMeters"] == 3_200
    assert second["rider_activity"]["savedRouteId"] == route["id"]
    assert second["activity"]["source"] == "rider-tracker"
    assert ActivityStore(database).get_facts("fit-route")["revision"] == 1

    with pytest.raises(ValueError, match="does not exist"):
        ingest_fit_activity(
            fit,
            activity_key="fit-missing-route",
            route_link={
                "saved_route_id": "missing-route",
                "start_distance_meters": 0,
                "end_distance_meters": 1000,
            },
            path=database,
        )
    assert ActivityStore(database).get_activity("fit-missing-route") is None
