"""Short, authenticated task requests; execution never occurs in these handlers."""
import sqlite3
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from domain.contracts.jobs import JobView
from services.jobs import JOB_TYPES, submit_job
from storage.repositories.job import JobConflict, JobStore
from storage.repositories.report_job import ReportJobStore


class SubmitJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_type: str = Field(min_length=1, max_length=80)
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    payload: dict[str, Any] = Field(default_factory=dict)


class JobRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def wrapped(request):
            try:
                return await handler(request)
            except RequestValidationError:
                status, code, message = 422, "validation_error", "Invalid task request."
            except HTTPException as exc:
                status = exc.status_code
                code, message = "unauthorized", "Task API access was denied."
            return JSONResponse(status_code=status, content={"schema_version": "error.v1",
                "request_id": uuid4().hex, "code": code, "message": message, "retryable": False, "details": {}})

        return wrapped


def create_job_router(authorize, *, types=None, store_factory=JobStore):
    router = APIRouter(dependencies=[Depends(authorize)], route_class=JobRoute)
    registry = JOB_TYPES if types is None else types

    def call(request, operation, request_id=None):
        correlation = request_id or uuid4().hex
        try:
            return operation(store_factory())
        except KeyError:
            status, code, message = 404, "not_found", "Task does not exist."
        except JobConflict:
            status, code, message = 409, "request_conflict", "Request ID belongs to different task input."
        except ValueError:
            status, code, message = 422, "validation_error", "Unsupported task type or invalid task input."
        except sqlite3.OperationalError:
            status, code, message = 503, "job_store_unavailable", "Task storage is temporarily unavailable."
        return JSONResponse(status_code=status, content={"schema_version": "error.v1",
            "request_id": correlation, "code": code, "message": message, "retryable": status == 503, "details": {}})

    @router.get("/api/jobs/capabilities")
    def capabilities(request: Request):
        return call(request, lambda store: {**store.availability(), "supported_job_types": sorted(registry)})

    @router.post("/api/jobs", status_code=202, response_model=JobView)
    def submit(body: SubmitJobRequest, request: Request):
        return call(request, lambda store: submit_job(store, registry, body.job_type, body.request_id, body.payload), body.request_id)

    @router.get("/api/jobs/{job_id}", response_model=JobView)
    def get_job(job_id: str, request: Request):
        return call(request, lambda store: store.get(job_id))

    @router.post("/api/jobs/{job_id}/cancel", response_model=JobView)
    def cancel_job(job_id: str, request: Request):
        return call(request, lambda store: store.cancel(job_id))

    @router.get("/api/jobs/{job_id}/report-rebuild")
    def report_rebuild(job_id: str, request: Request):
        return call(request, lambda store: {**ReportJobStore(store).view(job_id), **store.availability()})

    return router
