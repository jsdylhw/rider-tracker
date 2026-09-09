"""Submission and public-result service for durable route narration."""
from __future__ import annotations

from uuid import uuid4

from domain.contracts.narration_jobs import (
    ROUTE_NARRATION_JOB,
    RouteNarrationInput,
    narration_input_hash,
)
from services.jobs import JOB_TYPES, submit_job
from storage.repositories.job import JobStore
from storage.repositories.narration_job import NarrationJobStore


def submit_route_narration(
    payload,
    *,
    request_id=None,
    force=False,
    store=None,
):
    jobs = store or JobStore()
    normalized = RouteNarrationInput.model_validate(payload).model_dump(mode="json")
    digest = narration_input_hash(normalized)
    effective_request_id = request_id or (
        f"route-narration:{uuid4().hex}"
        if force
        else f"route-narration:{digest[:48]}"
    )
    submit_job(jobs, JOB_TYPES, ROUTE_NARRATION_JOB, effective_request_id, normalized)
    return get_route_narration_job_by_request(effective_request_id, store=jobs)


def get_route_narration_job(job_id, *, store=None):
    jobs = store or JobStore()
    return {**NarrationJobStore(jobs).view(job_id), **jobs.availability()}


def get_route_narration_job_by_request(request_id, *, store):
    with store._connection() as conn:
        row = conn.execute(
            "SELECT job_id FROM jobs WHERE scope='local' AND request_id=? AND job_type=?",
            (request_id, ROUTE_NARRATION_JOB),
        ).fetchone()
    if row is None:
        raise KeyError(request_id)
    return get_route_narration_job(row["job_id"], store=store)
