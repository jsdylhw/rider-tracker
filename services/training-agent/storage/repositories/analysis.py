"""SQLite repository for analysis navigation and focused result artifacts."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from storage.database import connect_database


class AnalysisStore:
    """Persist one navigation stack per workspace and immutable analysis results."""

    def __init__(self, path: str | Path | None = None):
        self.path = path

    def load_navigation(self, workspace_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT * FROM analysis_navigation WHERE workspace_id = ?",
                (str(workspace_id),),
            ).fetchone()
        if row is None:
            return None
        return {
            "schema_version": "analysis_navigation.v1",
            "workspace_id": str(row["workspace_id"]),
            "root_scope": _json_value(row["root_scope_json"], default=None),
            "focus_stack": _json_value(row["focus_stack_json"], default=[]),
            "last_result_id": row["last_result_id"],
            "revision": int(row["revision"] or 1),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }

    def save_navigation(self, navigation: dict[str, Any]) -> dict[str, Any]:
        workspace_id = str(navigation.get("workspace_id") or "").strip()
        if not workspace_id:
            raise ValueError("workspace_id is required")
        now = _now()
        with connect_database(self.path) as connection:
            existing = connection.execute(
                "SELECT revision, created_at FROM analysis_navigation WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchone()
            revision = int(existing["revision"] or 0) + 1 if existing else 1
            created_at = str(existing["created_at"]) if existing else now
            connection.execute(
                """
                INSERT INTO analysis_navigation (
                    workspace_id, root_scope_json, focus_stack_json,
                    last_result_id, revision, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(workspace_id) DO UPDATE SET
                    root_scope_json = excluded.root_scope_json,
                    focus_stack_json = excluded.focus_stack_json,
                    last_result_id = excluded.last_result_id,
                    revision = excluded.revision,
                    updated_at = excluded.updated_at
                """,
                (
                    workspace_id,
                    _json_dump(navigation.get("root_scope")),
                    _json_dump(navigation.get("focus_stack") or []),
                    navigation.get("last_result_id"),
                    revision,
                    created_at,
                    now,
                ),
            )
        return self.load_navigation(workspace_id) or {}

    def save_result(
        self,
        *,
        workspace_id: str,
        request: dict[str, Any],
        target: dict[str, Any],
        result: dict[str, Any],
        status: str = "completed",
    ) -> dict[str, Any]:
        """Store a completed tool result before the Main Agent writes prose."""
        now = _now()
        result_id = uuid4().hex
        fingerprint_payload = {"request": request, "target": target}
        input_hash = hashlib.sha256(
            _json_dump(fingerprint_payload, sort_keys=True).encode("utf-8")
        ).hexdigest()
        with connect_database(self.path) as connection:
            connection.execute(
                """
                INSERT INTO analysis_results (
                    id, workspace_id, request_json, target_json, result_json,
                    status, input_hash, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result_id,
                    str(workspace_id),
                    _json_dump(request),
                    _json_dump(target),
                    _json_dump(result),
                    str(status),
                    input_hash,
                    now,
                    now,
                ),
            )
        return {
            "id": result_id,
            "workspace_id": str(workspace_id),
            "status": str(status),
            "input_hash": input_hash,
            "created_at": now,
        }

    def get_result(self, result_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT * FROM analysis_results WHERE id = ?",
                (str(result_id),),
            ).fetchone()
        return _result_row(row) if row else None

    def get_latest_result(self, workspace_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                """
                SELECT * FROM analysis_results
                WHERE workspace_id = ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (str(workspace_id),),
            ).fetchone()
        return _result_row(row) if row else None


def _result_row(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "workspace_id": str(row["workspace_id"]),
        "request": _json_value(row["request_json"], default={}),
        "target": _json_value(row["target_json"], default={}),
        "result": _json_value(row["result_json"], default={}),
        "status": str(row["status"]),
        "input_hash": row["input_hash"],
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def _json_dump(value: Any, *, sort_keys: bool = False) -> str:
    return json.dumps(value, ensure_ascii=False, default=str, sort_keys=sort_keys)


def _json_value(value: Any, *, default: Any) -> Any:
    if value in {None, ""}:
        return default
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")
