from __future__ import annotations

import json
from pathlib import Path

import pytest

from domain.athlete import (
    enrich_training_metadata,
    get_ftp,
    get_max_hr,
    get_running_power_threshold,
    get_running_threshold_pace,
    get_resting_hr,
    get_threshold_hr,
    hr_zone_boundaries,
    load_athlete_profile,
    power_zone_boundaries,
    save_athlete_profile,
)


class TestLoadSaveAthleteProfile:
    def test_load_nonexistent_returns_empty(self):
        assert load_athlete_profile("/tmp/nonexistent_athlete.json") == {}

    def test_save_and_load_roundtrip(self, tmp_path):
        profile = {"ftp": 260, "max_heart_rate": 200, "resting_heart_rate": 50}
        path = tmp_path / "athlete.json"
        save_athlete_profile(profile, path)
        loaded = load_athlete_profile(path)
        assert loaded["ftp"] == 260
        assert loaded["max_heart_rate"] == 200

    def test_load_invalid_json_returns_empty(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("not json")
        assert load_athlete_profile(path) == {}

    def test_load_non_dict_returns_empty(self, tmp_path):
        path = tmp_path / "list.json"
        path.write_text(json.dumps([1, 2, 3]))
        assert load_athlete_profile(path) == {}


class TestGetters:
    def test_get_ftp(self):
        assert get_ftp({"ftp": 260}) == 260.0
        assert get_ftp({"ftp": "260"}) == 260.0
        assert get_ftp({}) is None
        assert get_ftp({"ftp": None}) is None

    def test_structured_profile_keeps_cycling_and_running_power_separate(self):
        profile = {
            "cycling": {"ftp_w": 260},
            "running": {"threshold_power_w": 310, "threshold_pace_s_per_km": 285},
        }
        assert get_ftp(profile) == 260.0
        assert get_ftp(profile, sport_type="running") is None
        assert get_running_power_threshold(profile) == 310.0
        assert get_running_threshold_pace(profile) == 285.0

    def test_get_max_hr(self):
        assert get_max_hr({"max_heart_rate": 200}) == 200.0
        assert get_max_hr({}) is None

    def test_get_resting_hr(self):
        assert get_resting_hr({"resting_heart_rate": 50}) == 50.0
        assert get_resting_hr({}) is None

    def test_get_threshold_hr(self):
        assert get_threshold_hr({"threshold_heart_rate": 175}) == 175.0
        assert get_threshold_hr({}) is None


class TestPowerZoneBoundaries:
    def test_coggan_zones(self):
        zones = power_zone_boundaries(260)
        assert zones == [143.0, 195.0, 234.0, 273.0, 312.0, 390.0]
        assert len(zones) == 6

    def test_zero_ftp(self):
        zones = power_zone_boundaries(0)
        assert all(z == 0.0 for z in zones)


class TestHRZoneBoundaries:
    def test_max_hr_percent(self):
        zones = hr_zone_boundaries(200)
        assert zones == [120.0, 140.0, 160.0, 180.0]
        assert len(zones) == 4

    def test_heart_rate_reserve(self):
        zones = hr_zone_boundaries(200, resting_hr=50)
        assert zones == [140.0, 155.0, 170.0, 185.0]

    def test_zero_max_hr(self):
        zones = hr_zone_boundaries(0)
        assert all(z == 0.0 for z in zones)


class TestEnrichTrainingMetadata:
    def test_empty_metadata_gets_enriched(self):
        """FIT 没有区间设定时,从档案补全."""
        profile = {"ftp": 260, "max_heart_rate": 200, "resting_heart_rate": 50, "threshold_heart_rate": 175}
        empty = {"zones_target": {}, "time_in_zone": [], "user_profile": {}}
        result = enrich_training_metadata(empty, profile)

        assert result["zones_target"]["functional_threshold_power"] == 260.0
        assert result["zones_target"]["max_heart_rate"] == 200.0
        assert result["zones_target"]["threshold_heart_rate"] == 175.0
        assert len(result["time_in_zone"]) == 2  # power + HR
        assert result["user_profile"]["resting_heart_rate"] == 50.0

    def test_existing_ftp_not_overwritten(self):
        """FIT 已有 FTP 时不被档案覆盖."""
        profile = {"ftp": 300}
        existing = {"zones_target": {"functional_threshold_power": 250}}
        result = enrich_training_metadata(existing, profile)
        assert result["zones_target"]["functional_threshold_power"] == 250

    def test_existing_max_hr_not_overwritten(self):
        """FIT 已有最大心率时不被档案覆盖."""
        profile = {"max_heart_rate": 210}
        existing = {
            "zones_target": {"max_heart_rate": 195},
            "user_profile": {},
        }
        result = enrich_training_metadata(existing, profile)
        assert result["zones_target"]["max_heart_rate"] == 195

    def test_existing_hr_zones_preserved_power_zones_added(self):
        """FIT 已有心率区间边界,只补功率区间."""
        profile = {"ftp": 260, "max_heart_rate": 200}
        existing = {
            "zones_target": {},
            "time_in_zone": [{"hr_zone_high_boundary": [120, 140, 160, 180]}],
        }
        result = enrich_training_metadata(existing, profile)
        # HR zones preserved
        hr_entries = [e for e in result["time_in_zone"] if "hr_zone_high_boundary" in e]
        assert len(hr_entries) == 1
        assert hr_entries[0]["hr_zone_high_boundary"] == [120, 140, 160, 180]
        # Power zones added
        pwr_entries = [e for e in result["time_in_zone"] if "power_zone_high_boundary" in e]
        assert len(pwr_entries) == 1
        assert pwr_entries[0]["power_zone_high_boundary"] == [143.0, 195.0, 234.0, 273.0, 312.0, 390.0]

    def test_no_profile_returns_unchanged(self):
        """没有档案时原样返回."""
        metadata = {"zones_target": {}, "time_in_zone": []}
        result = enrich_training_metadata(metadata, {})
        assert result == metadata

    def test_default_max_biking_hr_preserved(self):
        """user_profile.default_max_biking_heart_rate 也算已有最大心率."""
        profile = {"max_heart_rate": 210}
        existing = {
            "zones_target": {},
            "user_profile": {"default_max_biking_heart_rate": 195},
        }
        result = enrich_training_metadata(existing, profile)
        assert result["zones_target"].get("max_heart_rate") is None  # 不补,因为 user_profile 已有

    def test_user_profile_fields_appended(self):
        """档案中 weight/height 补到 user_profile."""
        profile = {"weight": 80, "height": 178}
        existing = {"user_profile": {}}
        result = enrich_training_metadata(existing, profile)
        assert result["user_profile"]["weight"] == 80
        assert result["user_profile"]["height"] == 178

    def test_power_zones_with_ftp_only(self):
        """只有 FTP,没有心率时只补功率区间."""
        profile = {"ftp": 260}
        existing = {"zones_target": {}, "time_in_zone": []}
        result = enrich_training_metadata(existing, profile)
        assert len(result["time_in_zone"]) == 1
        assert "power_zone_high_boundary" in result["time_in_zone"][0]

    def test_running_never_receives_legacy_cycling_ftp(self):
        metadata = {"zones_target": {}, "time_in_zone": [], "user_profile": {}}
        result = enrich_training_metadata(metadata, {"ftp": 260}, sport_type="running")

        assert "functional_threshold_power" not in result["zones_target"]
        assert result["analysis_profile"]["running_power_threshold_source"] == "unavailable"
        assert not any("power_zone_high_boundary" in item for item in result["time_in_zone"])

    def test_running_uses_only_explicit_running_power_threshold(self):
        metadata = {
            "zones_target": {"functional_threshold_power": 397},
            "time_in_zone": [],
            "user_profile": {},
        }
        profile = {"cycling": {"ftp_w": 397}, "running": {"threshold_power_w": 310}}
        result = enrich_training_metadata(metadata, profile, sport_type="running")

        # 原始 Garmin 字段可追溯，但分析阈值只能来自 running profile。
        assert result["zones_target"]["functional_threshold_power"] == 397
        assert result["analysis_profile"] == {
            "running_power_threshold_w": 310.0,
            "running_power_threshold_source": "athlete_profile.running",
            "running_threshold_pace_s_per_km": None,
            "running_threshold_pace_source": "unavailable",
            "running_critical_speed_mps": None,
            "running_critical_speed_source": "unavailable",
        }
