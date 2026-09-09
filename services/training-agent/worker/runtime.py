"""Single-slot worker; a heartbeat thread keeps long I/O leases alive."""
import logging
from threading import Event, Thread
from uuid import uuid4

from storage.repositories.job import JobStore, LeaseLost


logger = logging.getLogger(__name__)


class JobCancelled(RuntimeError):
    pass


class JobExecutionFailed(RuntimeError):
    def __init__(self, result_ref):
        self.result_ref = result_ref
        super().__init__("Task finished with failed items.")


class JobContext:
    def __init__(self, store, claim, lost):
        self.store, self.claim, self.lost = store, claim, lost

    def checkpoint(self, progress=None):
        if self.lost.is_set():
            raise LeaseLost("Worker lost its lease.")
        if self.store.checkpoint(self.claim["job_id"], self.claim["token"], progress):
            raise JobCancelled("Cancellation requested.")


class Worker:
    def __init__(self, handlers, *, store=None, lease_seconds=30, poll_seconds=0.5):
        if lease_seconds <= 0 or poll_seconds <= 0:
            raise ValueError("Worker intervals must be positive.")
        self.handlers = handlers
        self.store = store or JobStore()
        self.lease_seconds = lease_seconds
        self.poll_seconds = poll_seconds
        self.worker_id = uuid4().hex
        self.stop = Event()

    def run(self):
        logger.info("worker_started worker_id=%s job_types=%s", self.worker_id, sorted(self.handlers))
        try:
            while not self.stop.is_set():
                self.store.heartbeat(self.worker_id, self.handlers)
                self.store.recover()
                if not self.run_once():
                    self.stop.wait(self.poll_seconds)
        finally:
            self.store.remove_worker(self.worker_id)

    def run_once(self):
        claim = self.store.claim(self.worker_id, self.handlers, lease_seconds=self.lease_seconds)
        if claim is None:
            return False
        finished, lost = Event(), Event()

        def heartbeat():
            while not finished.wait(min(5, self.lease_seconds / 3)):
                try:
                    self.store.renew(claim["job_id"], claim["token"], lease_seconds=self.lease_seconds)
                    self.store.heartbeat(self.worker_id, self.handlers)
                except Exception:
                    lost.set()
                    return

        thread = Thread(target=heartbeat, name="job-heartbeat", daemon=True)
        thread.start()
        context = JobContext(self.store, claim, lost)
        logger.info("job_started job_id=%s job_type=%s", claim["job_id"], claim["job_type"])
        try:
            context.checkpoint()
            result = self.handlers[claim["job_type"]](context, claim["payload"])
            context.checkpoint()
            self.store.finish(claim["job_id"], claim["token"], result_ref=result)
            logger.info("job_finished job_id=%s", claim["job_id"])
        except JobCancelled:
            self._finish_if_owned(claim)
        except JobExecutionFailed as exc:
            self._finish_if_owned(claim, failed=True, result_ref=exc.result_ref)
        except LeaseLost:
            logger.warning("job_lease_lost job_id=%s", claim["job_id"])
        except Exception as exc:
            # Exception text may contain provider credentials, paths, or model content.
            logger.error("job_failed job_id=%s exception_type=%s", claim["job_id"], type(exc).__name__)
            self._finish_if_owned(claim, failed=True)
        finally:
            finished.set()
            thread.join()
        return True

    def _finish_if_owned(self, claim, *, failed=False, result_ref=None):
        try:
            self.store.finish(claim["job_id"], claim["token"], failed=failed, result_ref=result_ref)
        except LeaseLost:
            pass
