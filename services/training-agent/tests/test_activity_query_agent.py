from __future__ import annotations

import json

from agent.analysis.query import (
    _compact_raw_evidence,
    build_query_payload,
    parse_explicit_window,
    run_activity_query_agent,
)


def test_parse_explicit_time_and_distance_windows():
    assert parse_explicit_window("100–200 秒有没有冲刺") == (
        "get_time_intervals",
        {"bucket_seconds": 5, "start_s": 100, "end_s": 200},
    )
    assert parse_explicit_window("第 3-5 km 的爬坡怎么样") == (
        "get_distance_intervals",
        {"bucket_distance_m": 200, "start_d": 3000, "end_d": 5000},
    )


def test_exact_window_uses_one_lightweight_model_call(sample_parsed_fit, tmp_path, monkeypatch):
    fit_path = tmp_path / "focused.fit"
    fit_path.write_bytes(b"mock fit content")
    calls = []

    class FakeClient:
        def __init__(self, **kwargs):
            self.config = kwargs.get("config") or {}

        def create_messages(self, **kwargs):
            calls.append(kwargs)
            return {
                "id": "query-answer",
                "model": "test-model",
                "stop_reason": "tool_use",
                "content": [{
                    "type": "tool_use",
                    "id": "submit-query",
                    "name": "submit_query_answer",
                    "input": {
                        "answer": "100–200 秒内没有连续冲刺。",
                        "evidence": [{"label": "功率", "value": "输出未持续", "source": "get_time_intervals"}],
                        "limitations": ["仅判断指定时间窗口。"],
                    },
                }],
            }

    monkeypatch.setattr("agent.analysis.query.AnthropicMessagesClient", FakeClient)
    monkeypatch.setattr("agent.analysis.query.parse_fit", lambda path: sample_parsed_fit)
    monkeypatch.setattr("agent.analysis.query.new_session_id", lambda prefix: "query-test")
    monkeypatch.setattr("agent.analysis.query.append_chat_log", lambda *args, **kwargs: tmp_path / "query.jsonl")

    result = run_activity_query_agent(
        fit_path,
        question="100–200 秒有没有连续冲刺？",
    )

    assert result["status"] == "answered_query"
    assert result["answer"] == "100–200 秒内没有连续冲刺。"
    assert len(calls) == 1
    assert [tool["name"] for tool in calls[0]["tools"]] == ["submit_query_answer"]
    payload = json.loads(calls[0]["messages"][0]["content"])
    assert payload["raw_evidence"]["tool"] == "get_time_intervals"
    assert payload["raw_evidence"]["arguments"] == {
        "bucket_seconds": 5, "start_s": 100, "end_s": 200,
    }
    assert "activity_features" not in payload
    assert "strava_summary" not in json.dumps(payload, ensure_ascii=False)


def test_exact_query_payload_omits_full_activity_features():
    payload = build_query_payload(
        question="100-200秒如何",
        activity_key="a1",
        fit_summary={"sport_type": "cycling"},
        metrics={"schema_version": "activity_metrics.v2"},
        features={"sprint_candidates": [{"large": "candidate"}]},
        raw_evidence={"tool": "get_time_intervals", "result": {"available": True}},
    )

    assert "activity_features" not in payload
    assert payload["completion_contract"]["tool"] == "submit_query_answer"


def test_sprint_window_evidence_drops_unrelated_interval_columns():
    compact = _compact_raw_evidence(
        {
            "available": True,
            "window": {"start_s": 100, "end_s": 200},
            "series": {
                "start_s": [100],
                "avg_power_w": [300],
                "max_power_w": [500],
                "avg_hr_bpm": [160],
                "avg_altitude_m": [8],
                "avg_pace_s_per_km": [None],
                "power_w_zero_samples": [0],
            },
        },
        tool_name="get_time_intervals",
        question="100-200 秒有没有冲刺",
    )

    assert compact["window"] == {"start_s": 100, "end_s": 200}
    assert compact["series"] == {
        "start_s": [100],
        "avg_power_w": [300],
        "max_power_w": [500],
        "avg_hr_bpm": [160],
    }
