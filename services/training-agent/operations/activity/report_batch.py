"""Compatibility entry points for durable report jobs; never execute models here."""
from uuid import uuid4

from domain.contracts.report_jobs import REPORT_REBUILD_JOB
from services.jobs import JOB_TYPES, submit_job
from storage.repositories.job import JobStore
from storage.repositories.report_job import ReportJobStore


def submit_activity_report_rebuild(*, scope="all", activity_keys=None, request_id=None):
    store = JobStore()
    job = submit_job(store, JOB_TYPES, REPORT_REBUILD_JOB, request_id or uuid4().hex,
                     {"scope": scope, "activity_keys": activity_keys or []})
    return {**ReportJobStore(store).view(job["job_id"]), **store.availability()}


def get_activity_report_job(job_id):
    store = JobStore()
    try:
        return {**ReportJobStore(store).view(job_id), **store.availability()}
    except KeyError:
        return {"kind": "activity_report_job", "job_id": job_id, "status": "not_found"}


def cancel_activity_report_job(job_id):
    store = JobStore()
    ReportJobStore(store).view(job_id)
    store.cancel(job_id)
    return get_activity_report_job(job_id)
