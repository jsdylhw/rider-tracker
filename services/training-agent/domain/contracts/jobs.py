"""Public job snapshots. Execution inputs and lease credentials stay private."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class JobProgress(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage: str | None = Field(default=None, max_length=120)
    completed: int = Field(default=0, ge=0)
    total: int | None = Field(default=None, ge=0)


class JobView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["job.v1"] = "job.v1"
    job_id: str
    job_type: str
    request_id: str
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    progress: JobProgress
    cancel_requested: bool
    result_ref: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
