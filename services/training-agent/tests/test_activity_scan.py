from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fit.analysis.segments import scan_activity_segments


def _parsed_for_scan() -> dict:
    records = []
    distance = 0.0
    altitude = 40.0
    base_time = datetime(2026, 5, 18, 8, 0, tzinfo=timezone.utc)

    for second in range(180):
        power = 150
        cadence = 88
        speed = 8.0
        altitude_delta = 0.0

        if 60 <= second < 120:
            power = 265
            cadence = 72
            altitude_delta = 0.24
        if 130 <= second < 145:
            power = 620
            cadence = 105
            speed = 10.0
        if 150 <= second < 170:
            power = 0
            cadence = 0
            speed = 0.0

        distance += speed
        altitude += altitude_delta
        records.append({
            "timestamp": (base_time + timedelta(seconds=second)).isoformat(),
            "elapsed_s": float(second),
            "power": power,
            "heart_rate": 130 + second * 0.1,
            "cadence": cadence,
            "enhanced_speed": speed,
            "distance": distance,
            "enhanced_altitude": altitude,
        })

    return {
        "records": records,
        "sessions": [{"threshold_power": 240}],
        "training_metadata": {
            "zones_target": {"functional_threshold_power": 240},
        },
    }


def test_scan_activity_segments_detects_key_segments():
    result = scan_activity_segments(_parsed_for_scan(), window_seconds=30, step_seconds=10, max_segments=10)

    assert result["available"] is True
    assert result["schema_version"] == "activity_scan.v1"
    assert result["baselines"]["ftp_w"] == 240.0

    effort_types = {effort["type"] for effort in result["efforts"]}
    assert effort_types == {"high_power_interval"}
    assert result["summary"]["key_effort_count"] >= 1
    assert "notes" in result


def test_scan_activity_segments_handles_empty_records():
    result = scan_activity_segments({"records": []})

    assert result["available"] is False
    assert result["schema_version"] == "activity_scan.v1"


def test_scan_activity_segments_handles_records_without_altitude():
    parsed = _parsed_for_scan()
    for record in parsed["records"]:
        record.pop("enhanced_altitude")

    result = scan_activity_segments(parsed, window_seconds=30, step_seconds=10, max_segments=10)

    assert result["available"] is True
    assert result["summary"]["key_effort_count"] >= 1


def test_scan_activity_segments_resolves_threshold_hr_from_time_in_zone():
    parsed = _parsed_for_scan()
    parsed["sessions"][0]["threshold_heart_rate"] = 0
    parsed["sessions"][0]["total_timer_time"] = 120
    parsed["sessions"][0]["total_elapsed_time"] = 180
    parsed["training_metadata"]["time_in_zone"] = [{"threshold_heart_rate": 176}]

    result = scan_activity_segments(parsed, window_seconds=30, step_seconds=10, max_segments=10)

    assert result["baselines"]["threshold_hr_bpm"] == 176.0
    assert result["baselines"]["threshold_hr_source"] == "time_in_zone"
    assert result["notes"][0]["code"] == "record_span_exceeds_timer_time"
