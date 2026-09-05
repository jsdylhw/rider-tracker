"""Report batch checkpoints and fenced report commits share the jobs database."""
import json

from domain.analysis.artifacts import SUMMARY_SCHEMA_V2
from domain.contracts.report_jobs import REPORT_REBUILD_JOB
from project_paths import resolve_project_path
from storage.repositories.activity import save_report_in_transaction, _upsert_facts_row
from storage.repositories.job import JobStore


class ReportInputChanged(ValueError):
    pass


class ReportCancelled(RuntimeError):
    pass


def initialize_report_items(conn, job_id, payload):
    clauses, args = ["a.fit_file_path IS NOT NULL", "a.fit_file_path <> ''"], []
    if payload["activity_keys"]:
        clauses.append(f"a.id IN ({','.join('?' for _ in payload['activity_keys'])})")
        args.extend(payload["activity_keys"])
        selected = conn.execute(
            f"SELECT COUNT(*) FROM activities a WHERE {' AND '.join(clauses)}", args).fetchone()[0]
        if selected != len(payload["activity_keys"]):
            raise ValueError("Selected activities must exist and have FIT files.")
    if payload["scope"] == "outdated":
        clauses.append("(r.schema_version IS NULL OR r.schema_version <> ?)")
        args.append(SUMMARY_SCHEMA_V2)
    rows = conn.execute(f"""SELECT a.id,a.fit_file_path,COALESCE(r.revision,0) report_revision,
        COALESCE(f.revision,0) facts_revision FROM activities a
        LEFT JOIN activity_reports r ON r.activity_id=a.id LEFT JOIN activity_facts f ON f.activity_id=a.id
        WHERE {' AND '.join(clauses)} ORDER BY a.id LIMIT 1001""", args).fetchall()
    if len(rows) > 1000:
        raise ValueError("A report batch supports at most 1000 activities; select a smaller batch.")
    conn.executemany("""INSERT INTO report_job_items
        (job_id,activity_id,ordinal,fit_path,report_revision,facts_revision) VALUES (?,?,?,?,?,?)""",
        [(job_id, row["id"], i, row["fit_file_path"], row["report_revision"], row["facts_revision"]) for i, row in enumerate(rows)])
    conn.execute("UPDATE jobs SET progress_json=? WHERE job_id=?",
                 (json.dumps({"stage": "queued", "completed": 0, "total": len(rows)}), job_id))


class ReportJobStore:
    def __init__(self, jobs=None):
        self.jobs = jobs or JobStore()

    def pending(self, job_id):
        with self.jobs._connection() as conn:
            return [dict(row) for row in conn.execute(
                "SELECT * FROM report_job_items WHERE job_id=? AND status='pending' ORDER BY ordinal", (job_id,))]

    def _owned_item(self, conn, claim, activity_id):
        job = self.jobs._owned(conn, claim["job_id"], claim["token"])
        if job["cancel_requested"]:
            raise ReportCancelled("Cancellation requested.")
        row = conn.execute("SELECT * FROM report_job_items WHERE job_id=? AND activity_id=?",
                           (claim["job_id"], activity_id)).fetchone()
        if row is None:
            raise KeyError(activity_id)
        return row

    def prepare(self, claim, activity_id, input_hash):
        with self.jobs._connection(write=True) as conn:
            item = self._owned_item(conn, claim, activity_id)
            if item["status"] != "pending":
                return False
            self._validate_input(conn, item)
            if item["input_hash"] and item["input_hash"] != input_hash:
                raise ReportInputChanged("FIT changed since the first attempt.")
            conn.execute("UPDATE report_job_items SET input_hash=? WHERE job_id=? AND activity_id=?",
                         (input_hash, claim["job_id"], activity_id))
            return True

    @staticmethod
    def _validate_input(conn, item):
        current = conn.execute("""SELECT a.fit_file_path,COALESCE(r.revision,0) report_revision,
            COALESCE(f.revision,0) facts_revision FROM activities a
            LEFT JOIN activity_reports r ON r.activity_id=a.id LEFT JOIN activity_facts f ON f.activity_id=a.id
            WHERE a.id=?""", (item["activity_id"],)).fetchone()
        if (current is None or resolve_project_path(current["fit_file_path"]) != resolve_project_path(item["fit_path"])
                or current["report_revision"] != item["report_revision"]
                or current["facts_revision"] != item["facts_revision"]):
            raise ReportInputChanged("Activity or report changed after submission.")

    def commit(self, claim, activity_id, document):
        with self.jobs._connection(write=True) as conn:
            item = self._owned_item(conn, claim, activity_id)
            if item["status"] != "pending":
                return
            self._validate_input(conn, item)
            if (document.get("activity_key") != activity_id
                    or resolve_project_path(document.get("fit_path") or "") != resolve_project_path(item["fit_path"])):
                raise ReportInputChanged("Analyzer returned a different activity.")
            save_report_in_transaction(conn, {**document, "status": "analyzed"})
            features = document.get("activity_features") or {}
            if item["facts_revision"] == 0 and features.get("schema_version") == "activity_features.v1":
                _upsert_facts_row(conn, activity_id, metrics=document["activity_metrics"], features=features)
            conn.execute("UPDATE report_job_items SET status='succeeded' WHERE job_id=? AND activity_id=?",
                         (claim["job_id"], activity_id))
            self._progress(conn, claim["job_id"])

    def fail(self, claim, activity_id, code):
        if code not in {"analysis_failed", "input_changed", "fit_unavailable", "ai_unavailable"}:
            raise ValueError("Unknown report error code.")
        with self.jobs._connection(write=True) as conn:
            item = self._owned_item(conn, claim, activity_id)
            if item["status"] == "pending":
                conn.execute("UPDATE report_job_items SET status='failed',error_code=? WHERE job_id=? AND activity_id=?",
                             (code, claim["job_id"], activity_id))
                self._progress(conn, claim["job_id"])

    def _progress(self, conn, job_id):
        row = conn.execute("SELECT COUNT(*) total,SUM(status<>'pending') done FROM report_job_items WHERE job_id=?", (job_id,)).fetchone()
        conn.execute("UPDATE jobs SET progress_json=?,updated_at=? WHERE job_id=?",
            (json.dumps({"stage": "reports", "completed": int(row["done"] or 0), "total": row["total"]}), self.jobs.clock(), job_id))

    def view(self, job_id):
        # One read snapshot keeps job state and per-activity counts consistent.
        with self.jobs._connection() as conn:
            conn.execute("BEGIN")
            row = conn.execute("SELECT * FROM jobs WHERE job_id=? AND scope='local' AND job_type=?", (job_id, REPORT_REBUILD_JOB)).fetchone()
            if row is None:
                raise KeyError(job_id)
            job = self.jobs._view(row)
            items = [dict(item) for item in conn.execute(
                """SELECT i.activity_id,i.status,i.error_code,a.name title FROM report_job_items i
                LEFT JOIN activities a ON a.id=i.activity_id WHERE i.job_id=? ORDER BY i.ordinal""", (job_id,))]
        completed = sum(item["status"] == "succeeded" for item in items)
        failed = sum(item["status"] == "failed" for item in items)
        status = {"succeeded": "completed", "failed": "partial" if completed else "failed"}.get(job["status"], job["status"])
        return {"kind": "activity_report_job", "job_id": job_id, "status": status,
                "scope": json.loads(row["input_json"])["scope"],
                "total": len(items), "completed": completed, "failed": failed,
                "cancel_requested": job["cancel_requested"], "created_at": job["created_at"],
                "started_at": job["started_at"], "finished_at": job["finished_at"],
                "error": job["error"],
                "activities": [{"activity_key": item["activity_id"],
                    "title": item["title"] or "未命名活动",
                    "status": "completed" if item["status"] == "succeeded" else item["status"],
                    **({"error": item["error_code"]} if item["error_code"] else {})} for item in items]}
