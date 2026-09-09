from __future__ import annotations

import json

from storage.repositories.strava_route_catalog import (
    CATALOG_SCHEMA_VERSION,
    StravaRouteCatalogStore,
)


def test_missing_catalog_is_an_explicit_cache_miss(tmp_path):
    result = StravaRouteCatalogStore(tmp_path / "routes.json").load()

    assert result == {"routes": [], "cachedAt": None, "hasCache": False}


def test_replaced_catalog_survives_a_new_store_instance(tmp_path):
    path = tmp_path / "cache" / "strava-routes.json"
    saved = StravaRouteCatalogStore(path).replace([
        {"id": "123", "name": "三都经典线", "distanceMeters": 51182.9},
    ])

    loaded = StravaRouteCatalogStore(path).load()

    assert saved["hasCache"] is True
    assert loaded == saved
    assert loaded["routes"][0]["id"] == "123"


def test_empty_refresh_is_still_a_valid_cache(tmp_path):
    store = StravaRouteCatalogStore(tmp_path / "routes.json")

    saved = store.replace([])

    assert saved["hasCache"] is True
    assert store.load()["routes"] == []


def test_invalid_or_old_catalog_fails_closed(tmp_path):
    path = tmp_path / "routes.json"
    path.write_text(json.dumps({"schemaVersion": "old", "routes": [{"id": "1"}]}), encoding="utf-8")

    assert StravaRouteCatalogStore(path).load()["hasCache"] is False

    path.write_text("not-json", encoding="utf-8")
    assert StravaRouteCatalogStore(path).load()["hasCache"] is False


def test_catalog_file_uses_versioned_contract(tmp_path):
    path = tmp_path / "routes.json"
    StravaRouteCatalogStore(path).replace([])

    assert json.loads(path.read_text(encoding="utf-8"))["schemaVersion"] == CATALOG_SCHEMA_VERSION
