from copy import deepcopy
import json

import pytest
from pydantic import ValidationError
from services.narration.ride_hint import RideHintRequest, generate_ride_hint, prepare_hint_context, _slots
from agent.narration.ride_hint import compose_ride_hint
from domain.contracts.narration_jobs import RouteNarrationInput, narration_input_hash


def payload():
    def window(seconds):
        return {"requested_s": seconds, "actual_s": min(seconds, 100), "means": {"power": 130, "heartRate": None, "cadence": 85},
                "coverage_s": {"power": min(seconds, 100), "heartRate": 0, "cadence": min(seconds, 100)}}
    return {"schema_version": "route_narration_ride_hint.v1", "session_id": "ride_1", "route_fingerprint": "route_1234abcd",
            "plan_id": "plan_1", "item_id": "item_1", "context_revision": "erg_1",
            "snapshot": {"captured_at_ms": 100000, "elapsed_s": 100, "distance_m": 100,
                         "mode": "erg", "trainer": {"connected": True, "control_ready": True},
                         "target": {"erg_power_w": 200}, "route": {"name": "test", "total_distance_m": 10000, "nearby": []},
                         "card": {"title": "山坡", "summary": "地理知识", "category": "geography", "distance_m": 100},
                         "athlete": {"ftp_w": 250, "max_hr": 190, "resting_hr": 50},
                         "sensors": {"power_source": "virtual", "measured_power": False,
                                     "power": {"valid": True, "value": 130}, "heart_rate": {"valid": False, "value": None},
                                     "cadence": {"valid": True, "value": 85}, "historical_provenance": "unknown"},
                         "windows": [window(s) for s in (30, 300, 600)], "whole_ride": window(100),
                         "workout": {"current": None, "next": None}}}


class Client:
    def __init__(self, text="保持平顺", fail=False):
        self.calls = []
        self.text = text
        self.fail = fail
    def create_message(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("private provider body")
        return {"content": [{"type": "tool_use", "name": "submit_ride_hint", "input": {"text": self.text}}]}


def test_one_short_structured_call_and_authoritative_zones():
    request = RideHintRequest.model_validate(payload())
    client = Client()
    result = run_hint(request, client=client, ai_available=True)
    assert result["text"] == "保持平顺"
    assert result["session_id"] == "ride_1" and result["valid_for_s"] == 90
    assert len(client.calls) == 1 and client.calls[0]["thinking"] == "disabled"
    context = json.loads(client.calls[0]["user"])
    assert context["zones"]["power_upper_w"] == [137.5, 187.5, 225.0, 262.5, 300.0, 375.0]
    assert context["zones"]["heart_rate_method"] == "HRR"
    assert context["snapshot"]["target"]["erg_power_w"] == 200


def test_disabled_and_busy_never_call_provider():
    client = Client()
    request = RideHintRequest.model_validate(payload())
    assert run_hint(request, client=client, ai_available=False)["status"] == "unavailable"
    assert _slots.acquire(False) and _slots.acquire(False)
    try:
        assert run_hint(request, client=client, ai_available=True)["status"] == "busy"
    finally:
        _slots.release(); _slots.release()
    assert not client.calls


def test_failure_and_invalid_model_output_preserve_base_content():
    request = RideHintRequest.model_validate(payload())
    for client in (Client(fail=True), Client(text="x" * 161)):
        result = run_hint(request, client=client, ai_available=True)
        assert result["status"] == "unavailable" and result["text"] == ""
        assert "private" not in json.dumps(result)
        assert len(client.calls) == 1


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(schema_version="old"),
    lambda p: p["snapshot"].update(athlete=[]),
    lambda p: p["snapshot"].update(elapsed_s=float("nan")),
    lambda p: p["snapshot"].update(mode="sim"),
    lambda p: p["snapshot"]["windows"][0].update(actual_s=31),
    lambda p: p["snapshot"]["windows"][0]["coverage_s"].update(power=31),
    lambda p: p["snapshot"]["sensors"]["power"].update(value=float("inf")),
])
def test_snapshot_rejects_malformed_input(mutate):
    body = payload(); mutate(body)
    with pytest.raises(ValidationError):
        RideHintRequest.model_validate(body)


def test_generation_profile_changes_cache_identity_and_old_worker_payload_remains_unchanged():
    old = {"route_fingerprint": "route_1234abcd", "route_name": "test", "total_distance_m": 1000, "estimated_duration_min": 30,
           "samples": [{"sample_id": "a", "route_distance_m": 0, "latitude": 30, "longitude": 120},
                       {"sample_id": "b", "route_distance_m": 1000, "latitude": 30.1, "longitude": 120.1}]}
    unchanged = deepcopy(old)
    current = RouteNarrationInput.model_validate(old).model_dump(mode="json")
    assert current["generation_profile"] == "scenic_only.v2"
    assert narration_input_hash(old) != narration_input_hash(current)
    assert old == unchanged


def test_stale_values_are_removed_before_model_call():
    body = payload()
    body["snapshot"]["sensors"]["heart_rate"] = {"valid": False, "value": 180}
    context = prepare_hint_context(RideHintRequest.model_validate(body))
    assert context["snapshot"]["sensors"]["heart_rate"]["value"] is None


def test_disabled_configuration_is_respected_without_override(monkeypatch):
    import settings
    monkeypatch.setattr(settings, "load_config", lambda: {"agent": {
        "enabled": False, "base_url": "https://example.invalid", "api_key": "test", "model": "test"
    }, "google": {"api_key": "test"}})
    client = Client()
    assert run_hint(RideHintRequest.model_validate(payload()), client=client)["status"] == "unavailable"
    assert not client.calls


def run_hint(request, *, client, ai_available=None):
    return generate_ride_hint(request, compose=lambda context: compose_ride_hint(context, client=client), ai_available=ai_available)
