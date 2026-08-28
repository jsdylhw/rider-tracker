from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def isolate_runtime_data(tmp_path, monkeypatch):
    """Never let a Python test use or mutate the developer's Rider data tree."""
    database = tmp_path / "data" / "rider-tracker.db"
    monkeypatch.setenv("RIDER_PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RIDER_DATA_ROOT", str(tmp_path / "data"))
    monkeypatch.setenv("RIDER_TRACKER_DB_PATH", str(database))
    monkeypatch.setenv("TRAINING_AGENT_DB_PATH", str(database))
    monkeypatch.delenv("TRAINING_AGENT_MANAGED_DATABASE", raising=False)


@pytest.fixture
def sample_records():
    """Generate sample cycling records with power, HR, cadence, speed, distance."""
    from datetime import timedelta

    records = []
    distance = 0.0
    base_time = datetime(2026, 5, 14, 8, 0, 0, tzinfo=timezone.utc)
    for i in range(600):
        power = 150 + (i % 60) * 2  # 150-268 W
        hr = 130 + i * 0.05  # gradual HR drift
        speed = 8.0 + (i % 30) * 0.1  # 8.0-10.9 m/s
        cadence = 85 + (i % 10)
        distance += speed
        t = base_time + timedelta(seconds=i)
        records.append({
            "timestamp": t.isoformat(),
            "elapsed_s": float(i),
            "power": power,
            "heart_rate": hr,
            "cadence": cadence,
            "enhanced_speed": speed,
            "distance": round(distance, 1),
            "enhanced_altitude": 50.0 + i * 0.02,
            "position_lat": 35.0 + i * 0.0001,
            "position_long": 139.0 + i * 0.0001,
        })
    return records


@pytest.fixture
def sample_laps():
    return [
        {
            "start_time": "2026-05-14T08:00:00+00:00",
            "total_timer_time": 600.0,
            "total_elapsed_time": 620.0,
            "total_distance": 5000.0,
            "avg_speed": 8.33,
            "avg_power": 180.0,
            "max_power": 350.0,
            "avg_heart_rate": 145.0,
            "max_heart_rate": 175.0,
            "avg_cadence": 88.0,
            "total_ascent": 12.0,
            "total_descent": 5.0,
        }
    ]


@pytest.fixture
def sample_sessions():
    return [
        {
            "start_time": "2026-05-14T08:00:00+00:00",
            "sport": "cycling",
            "sub_sport": "road",
            "total_timer_time": 600.0,
            "total_elapsed_time": 620.0,
            "total_distance": 5000.0,
            "total_calories": 180.0,
            "avg_speed": 8.33,
            "avg_power": 180.0,
            "max_power": 350.0,
            "normalized_power": 195.0,
            "avg_heart_rate": 145.0,
            "max_heart_rate": 175.0,
            "avg_cadence": 88.0,
            "max_cadence": 105.0,
            "total_ascent": 12.0,
            "total_descent": 5.0,
            "training_stress_score": 45.0,
            "intensity_factor": 0.75,
            "threshold_power": 260.0,
            "total_work": 108000.0,
            "training_load_peak": 120.0,
            "total_training_effect": 3.2,
            "total_anaerobic_training_effect": 0.5,
        }
    ]


@pytest.fixture
def sample_sports():
    return [{"sport": "cycling", "sub_sport": "road"}]


@pytest.fixture
def sample_training_metadata():
    return {
        "message_counts": {"training_settings": 1, "zones_target": 1, "user_profile": 1, "device_info": 1},
        "training_settings": {"target_distance": 50000},
        "zones_target": {
            "functional_threshold_power": 260,
            "max_heart_rate": 200,
            "threshold_heart_rate": 170,
            "hr_calc_type": 2,
            "pwr_calc_type": 2,
        },
        "time_in_zone": [],
        "hrv": [],
        "user_profile": {
            "friendly_name": "Test Athlete",
            "gender": 1,
            "age": 30,
            "weight": 80.0,
            "resting_heart_rate": 50,
            "default_max_biking_heart_rate": 200,
            "default_max_heart_rate": 200,
        },
        "device_info": [
            {
                "timestamp": "2026-05-14T08:00:00",
                "manufacturer": "garmin",
                "garmin_product": "Edge 840",
                "product": "Edge 840",
                "software_version": "10.0",
            }
        ],
        "device_settings": {"lactate_threshold_autodetect_enabled": True},
        "events": [],
        "splits": [],
        "split_summary": [],
    }


@pytest.fixture
def sample_parsed_fit(sample_records, sample_laps, sample_sessions, sample_sports, sample_training_metadata):
    """Full parsed FIT data structure matching parse_fit() output."""
    from fit.parser import summarize_fit

    summary = summarize_fit(sample_records, sample_laps, sample_sessions, sample_sports)
    return {
        "path": "/tmp/test_activity.fit",
        "summary": summary,
        "records": sample_records,
        "laps": sample_laps,
        "sessions": sample_sessions,
        "sports": sample_sports,
        "training_metadata": sample_training_metadata,
    }


@pytest.fixture
def sample_activity_history_entry():
    return {
        "schema_version": "llm_activity_history_entry.v1",
        "activity_key": "abc123def456",
        "file_path": "/tmp/test_activity.fit",
        "start_time": "2026-05-14T08:00:00+00:00",
        "start_time_local": "2026-05-14T16:00:00+08:00",
        "sport_type": "cycling",
        "sub_sport": "road",
        "duration_s": 600.0,
        "distance_m": 5000.0,
        "brief": "30分钟恢复骑,Z1-Z2为主",
    }


@pytest.fixture
def temp_history_file():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write("")
    path = Path(f.name)
    yield path
    path.unlink(missing_ok=True)


@pytest.fixture
def temp_config_file():
    content = """
garmin_username: test@qq.com
garmin_password: testpass

agent:
  base_url: https://api.test.com/anthropic
  api_key: sk-test-key-123
  model: test-model
  max_tokens: 2000
  temperature: 0.5

strava:
  client_id: "12345"
  client_secret: "abc123"
  refresh_token: "refreshtoken123"
"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write(content)
    path = Path(f.name)
    yield path
    path.unlink(missing_ok=True)


@pytest.fixture
def mock_llm_response():
    return {
        "id": "msg_test123",
        "model": "test-model",
        "content": [
            {"type": "text", "text": '{"action": "tool", "tool": "get_activity_overview", "arguments": {}}'}
        ],
    }


@pytest.fixture
def mock_final_llm_response():
    return {
        "id": "msg_final456",
        "model": "test-model",
        "content": [
            {
                "type": "text",
                "text": json.dumps({
                    "action": "final",
                    "markdown_report": "# Test Activity Report\n\nTest content.",
                    "strava_summary": "测试 Strava 总结 200 字.",
                    "history_entry": {
                        "schema_version": "llm_activity_history_entry.v1",
                        "start_time": "2026-05-14T08:00:00+00:00",
                        "sport_type": "cycling",
                        "duration_min": 30,
                        "distance_km": 15.0,
                        "summary_label": "恢复骑",
                        "main_stimulus": "有氧耐力",
                        "training_load": "低负荷",
                        "quality_notes": ["数据质量良好"],
                        "brief": "紧凑中文笔记",
                    },
                }),
            }
        ],
    }


@pytest.fixture
def mock_strava_response():
    return MagicMock(
        json=lambda: {"id": 12345, "activity_id": 98765, "status": "ready"},
        ok=True,
        status_code=200,
    )
