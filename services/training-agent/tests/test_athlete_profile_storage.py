from __future__ import annotations

from domain import athlete
from services.athlete import profile as profile_service
from storage.repositories.athlete import AthleteProfileStore


def test_profile_store_roundtrip(tmp_path):
    database = tmp_path / "profile.db"
    profile = {
        "shared": {"weight_kg": 80, "max_heart_rate": 200},
        "cycling": {"ftp_w": 260},
    }

    AthleteProfileStore(database).save_profile(profile)

    assert AthleteProfileStore(database).get_profile() == profile


def test_default_profile_migrates_unified_config_once(tmp_path, monkeypatch):
    database = tmp_path / "profile.db"
    monkeypatch.setattr(profile_service, "AthleteProfileStore", lambda: AthleteProfileStore(database))
    monkeypatch.setattr(profile_service, "load_config", lambda: {
        "athlete": {
            "ftp": 275,
            "weight_kg": 79,
            "max_heart_rate": 198,
            "resting_heart_rate": 49,
        }
    })
    monkeypatch.setattr(profile_service, "DEFAULT_ATHLETE_PATH", tmp_path / "missing.json")

    profile = profile_service.get_athlete_profile()

    assert profile["cycling"]["ftp_w"] == 275
    assert profile["shared"]["resting_heart_rate"] == 49
    assert AthleteProfileStore(database).get_profile() == profile


def test_partial_legacy_profile_overrides_without_dropping_config_fields(tmp_path, monkeypatch):
    database = tmp_path / "profile.db"
    legacy = tmp_path / "athlete.json"
    legacy.write_text('{"mass": 82, "restingHr": 47}', encoding="utf-8")
    monkeypatch.setattr(profile_service, "AthleteProfileStore", lambda: AthleteProfileStore(database))
    monkeypatch.setattr(profile_service, "load_config", lambda: {
        "athlete": {"ftp": 275, "weight_kg": 79, "max_heart_rate": 198}
    })
    monkeypatch.setattr(profile_service, "DEFAULT_ATHLETE_PATH", legacy)

    profile = profile_service.get_athlete_profile()

    assert profile["cycling"]["ftp_w"] == 275
    assert profile["shared"]["weight_kg"] == 82
    assert profile["shared"]["resting_heart_rate"] == 47
    assert profile["shared"]["max_heart_rate"] == 198


def test_rider_settings_map_to_canonical_profile():
    profile = athlete.normalize_athlete_profile({
        "ftp": 280,
        "mass": 81,
        "restingHr": 48,
        "maxHr": 201,
        "cda": 0.31,
    })

    assert profile["cycling"]["ftp_w"] == 280
    assert profile["shared"]["weight_kg"] == 81
    assert athlete.athlete_profile_to_rider_settings(profile)["maxHr"] == 201
