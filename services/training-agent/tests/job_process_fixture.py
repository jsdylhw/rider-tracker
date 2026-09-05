"""Subprocess fixture only. Never imported by production API or worker."""
import sys
import time
import os
from functools import partial
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from app.job_api import create_job_router
from services.jobs import JOB_TYPES, JobType
from worker.runtime import Worker
from worker.handlers.report_rebuild import rebuild_reports
from domain.contracts.report_jobs import REPORT_REBUILD_JOB


class TestInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    steps: int = Field(default=2, ge=1, le=100)


def handle(ctx, payload):
    for index in range(payload["steps"]):
        ctx.checkpoint({"completed": index, "total": payload["steps"]})
        time.sleep(0.05)
    return {"fixture": "done"}


def fake_report(path, *, activity_key, **kwargs):
    assert kwargs["persist"] is False
    with Path(os.environ["REPORT_TEST_CALLS"]).open("a", encoding="utf-8") as log:
        log.write(activity_key + "\n")
    time.sleep(0.4 if activity_key == "stable-0" else 2)
    return {"schema_version": "llm_fit_file_analysis.v2", "activity_key": activity_key,
            "fit_path": str(path), "activity_metrics": {"schema_version": "activity_metrics.v2"},
            "analysis_summary": {"schema_version": "activity_analysis_summary.v1"},
            "markdown_report": "# process report", "strava_summary": "summary"}


if __name__ == "__main__":
    if sys.argv[1] == "worker":
        Worker({"test": handle}, lease_seconds=1, poll_seconds=0.05).run()
    elif sys.argv[1] == "report-worker":
        Worker({REPORT_REBUILD_JOB: partial(rebuild_reports, analyze=fake_report, ai_available=True)},
               lease_seconds=1, poll_seconds=0.05).run()
    else:
        import uvicorn
        from app.api import _require_api_access
        from app import api
        api.load_config = lambda: {"web_api_token": "fixture-token"}
        app = FastAPI()
        app.include_router(create_job_router(_require_api_access, types={**JOB_TYPES, "test": JobType(TestInput, "retry", 3)}))
        uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[2]), log_level="error")
