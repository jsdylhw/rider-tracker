"""Stable input contract for durable route-narration generation."""
from __future__ import annotations

from hashlib import sha256
import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


ROUTE_NARRATION_JOB = "route_narration.v1"


class RouteNarrationSample(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sample_id: str = Field(min_length=1, max_length=64)
    route_distance_m: float = Field(ge=0)
    estimated_elapsed_s: float | None = Field(default=None, ge=0)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    elevation_m: float | None = None
    grade_percent: float | None = None


class RouteNarrationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    route_fingerprint: str = Field(pattern=r"^route_[a-f0-9]{8}$")
    route_name: str = Field(min_length=1, max_length=200)
    total_distance_m: float = Field(gt=0, le=1_000_000)
    estimated_duration_min: float = Field(gt=0, le=10_000)
    duration_estimation: dict[str, Any] | None = None
    locale: str = Field(default="zh-CN", max_length=16)
    samples: list[RouteNarrationSample] = Field(min_length=2, max_length=64)

    @model_validator(mode="after")
    def validate_route_distances(self):
        distances = [sample.route_distance_m for sample in self.samples]
        if any(value > self.total_distance_m + 1 for value in distances):
            raise ValueError("Route sample exceeds total distance.")
        if any(second <= first for first, second in zip(distances, distances[1:])):
            raise ValueError("Route samples must be ordered by increasing distance.")
        if len({sample.sample_id for sample in self.samples}) != len(self.samples):
            raise ValueError("Route sample IDs must be unique.")
        return self


class RouteNarrationPrepareRequest(RouteNarrationInput):
    request_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_.:-]+$",
    )
    force: bool = False

    def job_input(self) -> dict[str, Any]:
        return self.model_dump(mode="json", exclude={"request_id", "force"})


def narration_input_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return sha256(encoded.encode()).hexdigest()
