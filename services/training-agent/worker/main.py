"""Production worker entry point. Schema must already be prepared by the launcher."""
import logging
import os
import signal

from services.jobs import JOB_TYPES
from worker.runtime import Worker
from worker.handlers.report_rebuild import rebuild_reports
from domain.contracts.report_jobs import REPORT_REBUILD_JOB


def main():
    os.environ["TRAINING_AGENT_MANAGED_DATABASE"] = "1"
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    handlers = {REPORT_REBUILD_JOB: rebuild_reports}
    if handlers.keys() != JOB_TYPES.keys():
        raise RuntimeError("Job submission and execution registries disagree.")
    worker = Worker(handlers)
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: worker.stop.set())
    worker.run()


if __name__ == "__main__":
    main()
