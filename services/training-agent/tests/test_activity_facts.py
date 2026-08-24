from __future__ import annotations

from operations.activity.facts import rebuild_activity_facts
from services.activity.catalog import upsert_activity_from_fit
from storage.repositories.activity import ActivityStore


def test_import_persists_metrics_and_feature_candidates(tmp_path, monkeypatch, sample_parsed_fit):
    fit_path = tmp_path / "ride.fit"
    fit_path.write_bytes(b"fit")
    database = tmp_path / "activities.db"
    monkeypatch.setattr("services.activity.catalog.parse_fit", lambda _path: sample_parsed_fit)
    monkeypatch.setattr("operations.activity.facts.parse_fit", lambda _path: sample_parsed_fit)

    activity = upsert_activity_from_fit(fit_path, path=database)
    facts = ActivityStore(database).get_facts(activity["activity_key"])

    assert activity["facts_schema_version"] == "activity_features.v1"
    assert facts["metrics"]["schema_version"] == "activity_metrics.v2"
    assert facts["features"]["schema_version"] == "activity_features.v1"
    assert "sprint_candidates" in facts["features"]
    assert "climb_candidates" in facts["features"]


def test_rebuild_facts_backfills_without_creating_report(tmp_path, monkeypatch, sample_parsed_fit):
    fit_path = tmp_path / "ride.fit"
    fit_path.write_bytes(b"fit")
    database = tmp_path / "activities.db"
    monkeypatch.setattr("services.activity.catalog.parse_fit", lambda _path: sample_parsed_fit)
    monkeypatch.setattr("operations.activity.facts.parse_fit", lambda _path: sample_parsed_fit)
    activity = upsert_activity_from_fit(fit_path, path=database)
    store = ActivityStore(database)

    # Simulate a database created before the facts table was introduced.
    with __import__("storage.database", fromlist=["connect_database"]).connect_database(database) as connection:
        connection.execute("DELETE FROM activity_facts WHERE activity_id = ?", (activity["activity_key"],))

    result = rebuild_activity_facts(path=database)

    assert result["status"] == "completed"
    assert result["rebuilt"] == 1
    assert store.get_facts(activity["activity_key"]) is not None
    assert store.get_report(activity["activity_key"]) is None
