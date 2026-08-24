from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from services.activity.presentation import DEFAULT_PROFILE_POINTS, activity_profile_from_records


def test_activity_profile_builds_elapsed_time_distance_series():
    start = datetime(2026, 8, 18, 8, 0)
    records = [
        {"timestamp": start + timedelta(minutes=index), "distance": index * 1250}
        for index in range(5)
    ]

    result = activity_profile_from_records(records)

    assert result == {
        "x_label": "经过时间",
        "labels": ["0:00", "1:00", "2:00", "3:00", "4:00"],
        "series": [{
            "metric": "cumulative_distance_km",
            "unit": "km",
            "values": [0.0, 1.25, 2.5, 3.75, 5.0],
        }],
    }


def test_activity_profile_downsamples_while_preserving_endpoints():
    start = datetime(2026, 8, 18, 8, 0)
    records = [
        {"timestamp": start + timedelta(seconds=index), "distance": index * 10}
        for index in range(101)
    ]

    result = activity_profile_from_records(records, max_points=10)

    assert len(result["labels"]) == 10
    assert result["labels"][0] == "0:00"
    assert result["labels"][-1] == "1:40"
    assert result["series"][0]["values"][0] == 0.0
    assert result["series"][0]["values"][-1] == 1.0


def test_activity_profile_default_keeps_up_to_300_points():
    start = datetime(2026, 8, 18, 8, 0)
    records = [
        {"timestamp": start + timedelta(seconds=index), "distance": index * 10}
        for index in range(1000)
    ]

    result = activity_profile_from_records(records)

    assert DEFAULT_PROFILE_POINTS == 300
    assert len(result["labels"]) == 300
    assert result["labels"][0] == "0:00"
    assert result["labels"][-1] == "16:39"


def test_activity_profile_averages_dense_sensor_buckets_instead_of_picking_spikes():
    start = datetime(2026, 8, 18, 8, 0)
    records = [
        {
            "timestamp": start + timedelta(seconds=index),
            "distance": index * 10,
            "heart_rate": 120 if index % 2 == 0 else 160,
            "power": 0 if index % 2 == 0 else 400,
        }
        for index in range(100)
    ]

    result = activity_profile_from_records(records, max_points=10)

    heart_rate = next(item for item in result["series"] if item["metric"] == "heart_rate_bpm")
    power = next(item for item in result["series"] if item["metric"] == "power_w")
    assert 135 <= heart_rate["values"][1] <= 145
    assert 180 <= power["values"][1] <= 220


def test_activity_profile_adds_available_heart_rate_and_power_series():
    start = datetime(2026, 8, 18, 8, 0)
    records = [
        {
            "timestamp": start + timedelta(minutes=index),
            "distance": index * 1000,
            "heart_rate": 130 + index * 5,
            "power": 160 + index * 10,
        }
        for index in range(3)
    ]

    result = activity_profile_from_records(records)

    assert [item["metric"] for item in result["series"]] == [
        "cumulative_distance_km", "heart_rate_bpm", "power_w",
    ]
    assert result["series"][1] == {
        "metric": "heart_rate_bpm", "unit": "bpm", "values": [130.0, 135.0, 140.0],
    }
    assert result["series"][2] == {
        "metric": "power_w", "unit": "W", "values": [160.0, 170.0, 180.0],
    }


def test_activity_profile_omits_missing_distance_and_rejects_invalid_limit():
    assert activity_profile_from_records([{"timestamp": "2026-08-18T08:00:00"}]) == {}
    with pytest.raises(ValueError, match="at least 2"):
        activity_profile_from_records([], max_points=1)
