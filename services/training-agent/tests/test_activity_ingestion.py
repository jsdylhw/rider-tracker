from __future__ import annotations

from services.activity.ingestion import get_activity_detail, ingest_fit_activity
from storage.repositories.activity import ActivityStore


def test_ingestion_reuses_existing_rider_identity_and_caches_detail(
    monkeypatch, tmp_path, sample_parsed_fit,
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
    assert ActivityStore(database).get_activity("fit-manual") is not None
