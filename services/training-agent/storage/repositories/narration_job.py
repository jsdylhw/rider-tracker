"""Fenced storage for route-narration plans produced by the Worker."""
from __future__ import annotations

import json

from domain.contracts.narration_jobs import ROUTE_NARRATION_JOB, narration_input_hash
from storage.repositories.job import JobStore


class NarrationInputChanged(ValueError):
    pass


class NarrationCancelled(RuntimeError):
    pass


def initialize_narration_result(conn, job_id, payload):
    conn.execute(
        """INSERT INTO route_narration_results
        (job_id,route_fingerprint,input_hash,status) VALUES (?,?,?,'pending')""",
        (job_id, payload["route_fingerprint"], narration_input_hash(payload)),
    )
    conn.execute(
        "UPDATE jobs SET progress_json=? WHERE job_id=?",
        (json.dumps({"stage": "queued", "completed": 0, "total": 3}), job_id),
    )


class NarrationJobStore:
    def __init__(self, jobs=None):
        self.jobs = jobs or JobStore()

    def ready_result(self, claim, payload):
        with self.jobs._connection() as conn:
            self.jobs._owned(conn, claim["job_id"], claim["token"])
            row = self._result_row(conn, claim["job_id"])
            self._validate(row, payload)
            return json.loads(row["plan_json"]) if row["status"] == "ready" and row["plan_json"] else None

    def commit(self, claim, payload, plan):
        with self.jobs._connection(write=True) as conn:
            job = self.jobs._owned(conn, claim["job_id"], claim["token"])
            if job["cancel_requested"]:
                raise NarrationCancelled("Cancellation requested.")
            row = self._result_row(conn, claim["job_id"])
            self._validate(row, payload)
            if plan.get("route_fingerprint") != row["route_fingerprint"]:
                raise NarrationInputChanged("Narration result belongs to another route.")
            conn.execute(
                """UPDATE route_narration_results
                SET status='ready',plan_json=?,error_code=NULL,updated_at=CURRENT_TIMESTAMP
                WHERE job_id=?""",
                (json.dumps(plan, ensure_ascii=False, allow_nan=False), claim["job_id"]),
            )
            conn.execute(
                "UPDATE jobs SET progress_json=?,updated_at=? WHERE job_id=?",
                (
                    json.dumps({"stage": "saving_plan", "completed": 3, "total": 3}),
                    self.jobs.clock(),
                    claim["job_id"],
                ),
            )

    def fail(self, claim, payload, code):
        if code not in {"ai_unavailable", "narration_failed", "input_changed"}:
            raise ValueError("Unknown narration error code.")
        with self.jobs._connection(write=True) as conn:
            job = self.jobs._owned(conn, claim["job_id"], claim["token"])
            if job["cancel_requested"]:
                raise NarrationCancelled("Cancellation requested.")
            row = self._result_row(conn, claim["job_id"])
            self._validate(row, payload)
            conn.execute(
                """UPDATE route_narration_results
                SET status='failed',plan_json=NULL,error_code=?,updated_at=CURRENT_TIMESTAMP
                WHERE job_id=?""",
                (code, claim["job_id"]),
            )

    def view(self, job_id):
        with self.jobs._connection() as conn:
            conn.execute("BEGIN")
            job_row = conn.execute(
                "SELECT * FROM jobs WHERE job_id=? AND scope='local' AND job_type=?",
                (job_id, ROUTE_NARRATION_JOB),
            ).fetchone()
            if job_row is None:
                raise KeyError(job_id)
            result = self._result_row(conn, job_id)
            job = self.jobs._view(job_row)
        result_ready = result["status"] == "ready" and bool(result["plan_json"])
        payload = {
            "kind": "route_narration_job",
            "job_id": job_id,
            # The dedicated, fenced result is authoritative. A process may
            # stop after committing it but before updating the generic job row.
            "status": "succeeded" if result_ready else job["status"],
            "progress": job["progress"],
            "cancel_requested": job["cancel_requested"],
            "route_fingerprint": result["route_fingerprint"],
            "created_at": job["created_at"],
            "started_at": job["started_at"],
            "finished_at": job["finished_at"],
        }
        if result_ready:
            payload["plan"] = json.loads(result["plan_json"])
        if result["error_code"]:
            payload["error"] = {
                "code": result["error_code"],
                "message": _error_message(result["error_code"]),
                "retryable": result["error_code"] != "input_changed",
            }
        return payload

    @staticmethod
    def _result_row(conn, job_id):
        row = conn.execute("SELECT * FROM route_narration_results WHERE job_id=?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        return row

    @staticmethod
    def _validate(row, payload):
        if (
            row["route_fingerprint"] != payload.get("route_fingerprint")
            or row["input_hash"] != narration_input_hash(payload)
        ):
            raise NarrationInputChanged("Route narration input changed after submission.")


def _error_message(code):
    return {
        "ai_unavailable": "路线讲解模型当前不可用，请检查配置后重试。",
        "input_changed": "路线已发生变化，请基于当前路线重新生成讲解。",
        "narration_failed": "路线讲解生成失败，请稍后重试。",
    }.get(code, "路线讲解任务失败。")
