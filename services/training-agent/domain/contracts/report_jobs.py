"""Bounded report-rebuild request; activity selection is frozen at submission."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


REPORT_REBUILD_JOB = "activity_report_rebuild.v1"


class ReportRebuildInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: Literal["all", "outdated"] = "all"
    activity_keys: list[str] = Field(default_factory=list, max_length=1000)

    @field_validator("activity_keys")
    @classmethod
    def normalize_keys(cls, value):
        if any(not key.strip() or len(key) > 128 for key in value):
            raise ValueError("Invalid activity key.")
        return sorted({key.strip() for key in value})
