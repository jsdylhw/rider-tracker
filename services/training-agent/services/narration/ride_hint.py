"""Ephemeral one-shot narration hints. Never persisted or sent to the job queue."""
from __future__ import annotations

import json
from threading import BoundedSemaphore
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator
from domain.athlete import power_zone_boundaries, hr_zone_boundaries

_slots = BoundedSemaphore(2)


class HintModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class SensorValue(HintModel):
    valid: bool
    value: float | None = Field(default=None, ge=0, le=3000)


class Sensors(HintModel):
    power_source: str = Field(max_length=80)
    measured_power: bool
    power: SensorValue
    heart_rate: SensorValue
    cadence: SensorValue
    historical_provenance: str = Field(max_length=300)


class Athlete(HintModel):
    ftp_w: float | None = Field(default=None, gt=0, le=1000)
    max_hr: float | None = Field(default=None, gt=0, le=250)
    resting_hr: float | None = Field(default=None, gt=0, le=150)


class Window(HintModel):
    requested_s: float = Field(ge=0, le=604800)
    actual_s: float = Field(ge=0, le=604800)
    means: dict[Literal["power", "heartRate", "cadence"], float | None]
    coverage_s: dict[Literal["power", "heartRate", "cadence"], float]

    @model_validator(mode="after")
    def validate_coverage(self):
        if self.actual_s > self.requested_s or any(not 0 <= v <= self.actual_s for v in self.coverage_s.values()):
            raise ValueError("Invalid window coverage.")
        if any(v is not None and not 0 <= v <= 3000 for v in self.means.values()):
            raise ValueError("Invalid window mean.")
        return self


class Target(HintModel):
    erg_power_w: float | None = Field(default=None, ge=0, le=2000)
    sim_grade_percent: float | None = Field(default=None, ge=-50, le=50)
    resistance_percent: float | None = Field(default=None, ge=0, le=100)


class Card(HintModel):
    title: str = Field(max_length=500)
    summary: str = Field(max_length=4000)
    category: str = Field(max_length=100)
    distance_m: float = Field(ge=0, le=1000000)


class Nearby(HintModel):
    distance_m: float = Field(ge=0, le=1001000)
    grade_percent: float | None = Field(default=None, ge=-100, le=100)


class Route(HintModel):
    name: str = Field(max_length=200)
    total_distance_m: float = Field(gt=0, le=1000000)
    nearby: list[Nearby] = Field(max_length=5)


class Trainer(HintModel):
    connected: bool
    control_ready: bool


class Snapshot(HintModel):
    captured_at_ms: float = Field(ge=0)
    elapsed_s: float = Field(ge=0, le=604800)
    distance_m: float = Field(ge=0, le=1001000)
    mode: Literal["erg", "sim", "resistance"]
    trainer: Trainer
    target: Target
    route: Route
    card: Card
    athlete: Athlete
    sensors: Sensors
    windows: list[Window] = Field(min_length=3, max_length=3)
    whole_ride: Window
    workout: dict[Literal["current", "next"], dict[str, JsonValue] | None]

    @model_validator(mode="after")
    def validate_mode_target(self):
        if (self.mode != "erg" and self.target.erg_power_w is not None
            or self.mode != "sim" and self.target.sim_grade_percent is not None
            or self.mode != "resistance" and self.target.resistance_percent is not None):
            raise ValueError("Target does not match mode.")
        if [w.requested_s for w in self.windows] != [30, 300, 600]:
            raise ValueError("Invalid window durations.")
        return self


class RideHintRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    schema_version: Literal["route_narration_ride_hint.v1"]
    session_id: str = Field(min_length=1, max_length=128)
    route_fingerprint: str = Field(pattern=r"^route_[a-f0-9]{8}$")
    plan_id: str = Field(min_length=1, max_length=128)
    item_id: str = Field(min_length=1, max_length=128)
    context_revision: str = Field(min_length=1, max_length=256)
    snapshot: Snapshot


def prepare_hint_context(request):
    snapshot = request.snapshot.model_dump(mode="json")
    if len(json.dumps(snapshot, allow_nan=False)) > 24000:
        raise ValueError("Ride hint snapshot too large.")
    if snapshot.get("mode") not in ("erg", "sim", "resistance"):
        raise ValueError("Invalid control mode.")
    # Do not expose stale values as usable measurements even when the flag is present.
    for name in ("power", "heart_rate", "cadence"):
        if not snapshot["sensors"][name]["valid"]:
            snapshot["sensors"][name]["value"] = None
    # Browser aggregates the actual ride records; Python alone owns zone rules.
    athlete = snapshot.get("athlete") or {}
    def positive(key, maximum):
        value = athlete.get(key)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= maximum else None
    ftp, max_hr, resting_hr = positive("ftp_w", 1000), positive("max_hr", 250), positive("resting_hr", 150)
    zones = {"power_upper_w": power_zone_boundaries(ftp) if ftp else None,
             "heart_rate_upper_bpm": hr_zone_boundaries(max_hr, resting_hr=resting_hr if resting_hr and resting_hr < max_hr else None) if max_hr else None,
             "heart_rate_method": "HRR" if max_hr and resting_hr and resting_hr < max_hr else "max_hr" if max_hr else None}
    return {"snapshot": snapshot, "zones": zones}


def generate_ride_hint(request: RideHintRequest, *, compose, ai_available=None):
    context = prepare_hint_context(request)
    identity = request.model_dump(exclude={"snapshot"})
    result = {**identity, "captured_at_ms": request.snapshot.model_dump().get("captured_at_ms"), "elapsed_s": request.snapshot.model_dump().get("elapsed_s"),
              "valid_for_s": 90, "text": "", "status": "unavailable"}
    if not _slots.acquire(blocking=False):
        return {**result, "status": "busy"}
    try:
        if ai_available is None:
            from services.capabilities import build_backend_capabilities
            from settings import load_config
            ai_available = build_backend_capabilities(load_config())["capabilities"]["route_narration"]
        if not ai_available:
            return result
        text = compose(context)
        if not isinstance(text, str) or len(text) > 160:
            return result
        return {**result, "status": "ready", "text": text.strip()}
    except Exception:
        # No provider error bodies, credentials or supplied sensor data in the response.
        return result
    finally:
        _slots.release()
