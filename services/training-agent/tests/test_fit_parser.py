from __future__ import annotations

import pandas as pd
import pytest

from fit.parser import (
    _clean_value,
    _num,
    _parse_datetime,
    records_dataframe,
    summarize_fit,
    summarize_training_metadata,
)


class TestCleanValue:
    def test_primitives_pass_through(self):
        assert _clean_value(42) == 42
        assert _clean_value(3.14) == 3.14
        assert _clean_value("hello") == "hello"
        assert _clean_value(True) is True
        assert _clean_value(None) is None

    def test_list_converts_items(self):
        from datetime import datetime, timezone

        dt = datetime(2026, 5, 14, 8, 0, tzinfo=timezone.utc)
        result = _clean_value([42, dt])
        assert result[0] == 42
        assert isinstance(result[1], str)

    def test_dict_converts_values(self):
        result = _clean_value({"a": 1, "b": [2, 3]})
        assert result["a"] == 1
        assert result["b"] == [2, 3]


class TestNum:
    def test_int_to_float(self):
        assert _num(42) == 42.0

    def test_float_passes_through(self):
        assert _num(3.14) == 3.14

    def test_none_returns_none(self):
        assert _num(None) is None

    def test_invalid_returns_none(self):
        assert _num("abc") is None

    def test_string_number(self):
        assert _num("42.5") == 42.5


class TestParseDatetime:
    def test_datetime_object(self):
        from datetime import datetime, timezone

        dt = datetime(2026, 5, 14, 8, 0, tzinfo=timezone.utc)
        result = _parse_datetime(dt)
        assert result == dt

    def test_iso_string_utc(self):
        result = _parse_datetime("2026-05-14T08:00:00+00:00")
        assert result is not None
        assert result.year == 2026
        assert result.month == 5

    def test_naive_datetime_gets_utc(self):
        from datetime import datetime, timezone

        dt = datetime(2026, 5, 14, 8, 0)
        result = _parse_datetime(dt)
        assert result.tzinfo == timezone.utc

    def test_none_returns_none(self):
        assert _parse_datetime(None) is None


class TestSummarizeFit:
    def test_basic_summary(self, sample_records, sample_laps, sample_sessions, sample_sports):
        result = summarize_fit(sample_records, sample_laps, sample_sessions, sample_sports)
        assert result["sport_type"] == "cycling"
        assert result["sub_sport"] == "road"
        assert result["record_count"] == 600
        assert result["lap_count"] == 1
        assert result["has_power"] is True
        assert result["has_heart_rate"] is True
        assert result["has_position"] is True

    def test_empty_records(self, sample_laps, sample_sessions, sample_sports):
        result = summarize_fit([], sample_laps, sample_sessions, sample_sports)
        assert result["sport_type"] == "cycling"
        assert result["record_count"] == 0

    def test_no_sessions_falls_back_to_sport(self, sample_records):
        sports = [{"sport": "running"}]
        result = summarize_fit(sample_records, [], [], sports)
        assert result["sport_type"] == "running"

    def test_unknown_sport_when_empty(self):
        result = summarize_fit([], [], [], [])
        assert result["sport_type"] == "unknown"

    def test_heart_rate_detection(self):
        records = [{"heart_rate": 140}, {"power": 200}]
        result = summarize_fit(records, [], [], [])
        assert result["has_heart_rate"] is True
        assert result["has_power"] is True

    def test_duration_from_session(self, sample_records):
        sessions = [{"total_timer_time": 3600.0}]
        result = summarize_fit(sample_records, [], sessions, [])
        assert result["duration_s"] == 3600.0


class TestRecordsDataframe:
    def test_empty_records(self):
        df = records_dataframe([])
        assert df.empty

    def test_adds_elapsed_s_column(self, sample_records):
        df = records_dataframe(sample_records)
        assert "elapsed_s" in df.columns
        assert df["elapsed_s"].iloc[0] == 0.0

    def test_sorts_by_timestamp(self, sample_records):
        import copy

        shuffled = copy.deepcopy(sample_records)
        shuffled[0], shuffled[-1] = shuffled[-1], shuffled[0]
        df = records_dataframe(shuffled)
        assert df["elapsed_s"].iloc[0] == 0.0

    def test_no_timestamp_column(self):
        records = [{"power": 150, "heart_rate": 140}]
        df = records_dataframe(records)
        assert "elapsed_s" not in df.columns


class TestSummarizeTrainingMetadata:
    """Tests for summarize_training_metadata with raw message format (dict of str->list)."""

    @pytest.fixture
    def raw_training_messages(self):
        return {
            "training_settings": [
                {"target_distance": 50000, "target_speed": 30.0},
            ],
            "zones_target": [
                {
                    "functional_threshold_power": 260,
                    "max_heart_rate": 200,
                    "threshold_heart_rate": 170,
                    "hr_calc_type": 2,
                    "pwr_calc_type": 2,
                }
            ],
            "time_in_zone": [],
            "hrv": [],
            "user_profile": [
                {
                    "friendly_name": "Test Athlete",
                    "gender": 1,
                    "age": 30,
                    "weight": 80.0,
                    "resting_heart_rate": 50,
                    "default_max_biking_heart_rate": 200,
                }
            ],
            "device_info": [
                {
                    "timestamp": "2026-05-14T08:00:00",
                    "manufacturer": "garmin",
                    "garmin_product": "Edge 840",
                    "product": "Edge 840",
                    "software_version": "10.0",
                }
            ],
            "device_settings": [
                {"lactate_threshold_autodetect_enabled": True},
            ],
            "event": [],
            "split": [],
            "split_summary": [],
        }

    def test_returns_message_counts(self, raw_training_messages):
        result = summarize_training_metadata(raw_training_messages)
        assert "message_counts" in result
        assert result["message_counts"]["training_settings"] == 1
        assert result["message_counts"]["device_info"] == 1

    def test_extracts_zones_target(self, raw_training_messages):
        result = summarize_training_metadata(raw_training_messages)
        assert result["zones_target"]["functional_threshold_power"] == 260
        assert result["zones_target"]["max_heart_rate"] == 200

    def test_extracts_user_profile(self, raw_training_messages):
        result = summarize_training_metadata(raw_training_messages)
        assert result["user_profile"]["weight"] == 80.0
        assert result["user_profile"]["resting_heart_rate"] == 50

    def test_empty_messages(self):
        result = summarize_training_metadata({})
        assert result["message_counts"] == {}
        assert result["zones_target"] == {}
