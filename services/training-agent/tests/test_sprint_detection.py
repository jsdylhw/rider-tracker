from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fit.analysis.sprints import detect_sprints


def _parsed_with_sprints() -> dict:
    start = datetime(2026, 8, 13, tzinfo=timezone.utc)
    records = []
    for second in range(80):
        power = 120
        if 10 <= second <= 16:
            power = 500
        if 40 <= second <= 44:
            power = 460
        records.append({
            "timestamp": start + timedelta(seconds=second),
            "power": power,
            "heart_rate": 130 + second // 10,
            "cadence": 85,
            "enhanced_speed": 8.0,
        })
    return {
        "summary": {"sport_type": "cycling"},
        "records": records,
        "sessions": [{"threshold_power": 250}],
        "training_metadata": {},
    }


def test_short_sprint_detector_returns_concrete_windows():
    result = detect_sprints(_parsed_with_sprints())

    assert result["schema_version"] == "sprint_detection.v1"
    assert result["count"] == 2
    assert result["segments"][0]["start_s"] == 10.0
    assert result["segments"][0]["duration_s"] == 7.0
    assert result["segments"][0]["max_power_w"] == 500.0


def test_short_sprint_detector_does_not_return_steady_endurance():
    parsed = _parsed_with_sprints()
    for record in parsed["records"]:
        record["power"] = 150

    result = detect_sprints(parsed)

    assert result["count"] == 0
