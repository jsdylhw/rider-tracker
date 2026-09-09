"""Durable job queue with atomic claims and fenced, expiring leases.

All connections close here. No caller executes a handler inside a transaction.
Recovery is at-least-once; retry-safe handlers must fence their domain writes too.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import time
from uuid import uuid4

from domain.contracts.jobs import JobProgress, JobView
from storage.database import connect_database


class JobConflict(ValueError):
    pass


class LeaseLost(RuntimeError):
    pass


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


class JobStore:
    def __init__(self, path=None, *, clock=time.time):
        self.path = path
        self.clock = clock

    @contextmanager
    def _connection(self, *, write=False):
        connection = connect_database(self.path, busy_timeout_ms=1000)
        try:
            if write:
                connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def submit(self, job_type, request_id, payload, *, scope="local", recovery="fail", max_attempts=1, initialize=None):
        if not job_type or not request_id or len(request_id) > 128:
            raise ValueError("Invalid job type or request ID.")
        if recovery not in {"retry", "fail"} or not 1 <= max_attempts <= 5:
            raise ValueError("Invalid recovery policy.")
        encoded = _json(payload)
        if len(encoded.encode()) > 65536:
            raise ValueError("Job input exceeds 64 KiB.")
        digest = sha256((job_type + "\n" + encoded).encode()).hexdigest()
        now = self.clock()
        with self._connection(write=True) as conn:
            old = conn.execute("SELECT * FROM jobs WHERE scope=? AND request_id=?", (scope, request_id)).fetchone()
            if old:
                if old["input_hash"] != digest:
                    raise JobConflict("Request ID already belongs to different job input.")
                return self._view(old)
            job_id = uuid4().hex
            conn.execute("""INSERT INTO jobs
                (job_id,job_type,request_id,scope,input_json,input_hash,status,recovery,max_attempts,created_at,updated_at)
                VALUES (?,?,?,?,?,?,'queued',?,?,?,?)""",
                (job_id, job_type, request_id, scope, encoded, digest, recovery, max_attempts, now, now))
            if initialize is not None:
                initialize(conn, job_id, payload)
            return self._view(conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone())

    def get(self, job_id, *, scope="local"):
        with self._connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE job_id=? AND scope=?", (job_id, scope)).fetchone()
            if row is None:
                raise KeyError(job_id)
            return self._view(row)

    def cancel(self, job_id, *, scope="local"):
        now = self.clock()
        with self._connection(write=True) as conn:
            row = conn.execute("SELECT * FROM jobs WHERE job_id=? AND scope=?", (job_id, scope)).fetchone()
            if row is None:
                raise KeyError(job_id)
            if row["status"] in {"queued", "running"}:
                queued = row["status"] == "queued"
                conn.execute("""UPDATE jobs SET cancel_requested=1, status=?, finished_at=?, updated_at=?
                    WHERE job_id=?""", ("cancelled" if queued else "running", now if queued else None, now, job_id))
            return self._view(conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone())

    def claim(self, worker_id, job_types, *, lease_seconds=30):
        if lease_seconds <= 0:
            raise ValueError("Lease must be positive.")
        if not job_types:
            return None
        now = self.clock()
        with self._connection(write=True) as conn:
            self._recover(conn, now)
            marks = ",".join("?" for _ in job_types)
            row = conn.execute(f"SELECT * FROM jobs WHERE status='queued' AND job_type IN ({marks}) ORDER BY created_at,job_id LIMIT 1", tuple(job_types)).fetchone()
            if row is None:
                return None
            token = uuid4().hex
            conn.execute("""UPDATE jobs SET status='running',worker_id=?,claim_token=?,lease_until=?,
                attempt=attempt+1,started_at=COALESCE(started_at,?),updated_at=? WHERE job_id=?""",
                (worker_id, token, now + lease_seconds, now, now, row["job_id"]))
            return {"job_id": row["job_id"], "job_type": row["job_type"], "token": token,
                    "payload": json.loads(row["input_json"])}

    def _recover(self, conn, now):
        rows = conn.execute("SELECT * FROM jobs WHERE status='running' AND lease_until<=?", (now,)).fetchall()
        for row in rows:
            if row["cancel_requested"]:
                status, error = "cancelled", None
            elif row["recovery"] == "retry" and row["attempt"] < row["max_attempts"]:
                status, error = "queued", None
            else:
                status = "failed"
                error = _json({"code": "worker_interrupted", "message": "Worker lease expired; execution may be incomplete.", "retryable": False})
            conn.execute("""UPDATE jobs SET status=?,error_json=?,worker_id=NULL,claim_token=NULL,lease_until=NULL,
                updated_at=?,finished_at=? WHERE job_id=?""",
                (status, error, now, None if status == "queued" else now, row["job_id"]))

    def recover(self):
        with self._connection(write=True) as conn:
            self._recover(conn, self.clock())

    def _owned(self, conn, job_id, token):
        row = conn.execute("SELECT * FROM jobs WHERE job_id=? AND claim_token=? AND status='running' AND lease_until>?",
                           (job_id, token, self.clock())).fetchone()
        if row is None:
            raise LeaseLost("Job lease is no longer owned by this execution.")
        return row

    def renew(self, job_id, token, *, lease_seconds=30):
        with self._connection(write=True) as conn:
            row = self._owned(conn, job_id, token)
            conn.execute("UPDATE jobs SET lease_until=?,updated_at=? WHERE job_id=?", (self.clock()+lease_seconds, self.clock(), job_id))
            return bool(row["cancel_requested"])

    def checkpoint(self, job_id, token, progress=None):
        with self._connection(write=True) as conn:
            row = self._owned(conn, job_id, token)
            if progress is not None and not row["cancel_requested"]:
                value = JobProgress.model_validate(progress)
                if value.total is not None and value.completed > value.total:
                    raise ValueError("Completed count exceeds total.")
                conn.execute("UPDATE jobs SET progress_json=?,updated_at=? WHERE job_id=?",
                             (_json(value.model_dump()), self.clock(), job_id))
            return bool(row["cancel_requested"])

    def finish(self, job_id, token, *, result_ref=None, failed=False):
        # Only stable, handler-owned references belong here; never raw exceptions or model output.
        encoded = _json(result_ref) if result_ref is not None else None
        if encoded and (not isinstance(result_ref, dict) or len(encoded.encode()) > 8192):
            raise ValueError("Result reference must be a bounded object.")
        with self._connection(write=True) as conn:
            row = self._owned(conn, job_id, token)
            cancelled = bool(row["cancel_requested"])
            status = "cancelled" if cancelled else "failed" if failed else "succeeded"
            error = _json({"code": "job_failed", "message": "Task execution failed.", "retryable": False}) if status == "failed" else None
            conn.execute("""UPDATE jobs SET status=?,result_ref_json=?,error_json=?,finished_at=?,updated_at=?,
                worker_id=NULL,claim_token=NULL,lease_until=NULL WHERE job_id=?""",
                (status, encoded if status != "cancelled" else None, error, self.clock(), self.clock(), job_id))

    def heartbeat(self, worker_id, job_types):
        with self._connection(write=True) as conn:
            conn.execute("DELETE FROM job_workers WHERE heartbeat_at<?", (self.clock()-86400,))
            conn.execute("""INSERT INTO job_workers VALUES (?,?,?) ON CONFLICT(worker_id)
                DO UPDATE SET job_types_json=excluded.job_types_json,heartbeat_at=excluded.heartbeat_at""",
                (worker_id, _json(sorted(job_types)), self.clock()))

    def remove_worker(self, worker_id):
        with self._connection(write=True) as conn:
            conn.execute("DELETE FROM job_workers WHERE worker_id=?", (worker_id,))

    def availability(self):
        with self._connection() as conn:
            rows = conn.execute("SELECT job_types_json FROM job_workers WHERE heartbeat_at>?", (self.clock()-15,)).fetchall()
        return {"worker": "available" if rows else "unavailable",
                "job_types": sorted({kind for row in rows for kind in json.loads(row[0])})}

    @staticmethod
    def _view(row):
        def date(name):
            return datetime.fromtimestamp(row[name], timezone.utc) if row[name] is not None else None
        return JobView(job_id=row["job_id"], job_type=row["job_type"], request_id=row["request_id"],
            status=row["status"], progress=json.loads(row["progress_json"]), cancel_requested=bool(row["cancel_requested"]),
            result_ref=json.loads(row["result_ref_json"]) if row["result_ref_json"] else None,
            error=json.loads(row["error_json"]) if row["error_json"] else None,
            **{key: date(key) for key in ("created_at", "updated_at", "started_at", "finished_at")}).model_dump(mode="json")
