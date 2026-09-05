"""Type-checked submission policies shared by API and worker composition roots."""
from dataclasses import dataclass
from typing import Callable, Literal

from pydantic import BaseModel

from storage.repositories.job import JobStore
from domain.contracts.report_jobs import REPORT_REBUILD_JOB, ReportRebuildInput
from storage.repositories.report_job import initialize_report_items


@dataclass(frozen=True)
class JobType:
    input_model: type[BaseModel]
    recovery: Literal["retry", "fail"] = "fail"
    max_attempts: int = 1
    initialize: Callable | None = None


# Register each business type together with its worker handler and recovery policy.
# No user-controlled import paths, shell commands, or test handlers are supported.
JOB_TYPES: dict[str, JobType] = {
    REPORT_REBUILD_JOB: JobType(ReportRebuildInput, "retry", 3, initialize_report_items),
}


def submit_job(store: JobStore, types, job_type, request_id, payload):
    definition = types.get(job_type)
    if definition is None:
        raise ValueError("Unsupported job type.")
    normalized = definition.input_model.model_validate(payload).model_dump(mode="json")
    return store.submit(job_type, request_id, normalized, recovery=definition.recovery,
                        max_attempts=definition.max_attempts, initialize=definition.initialize)
