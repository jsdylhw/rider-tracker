"""SQLite repository for full route-plan artifacts and compact recovery state."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from storage.database import connect_database


class RouteRevisionConflict(ValueError):
    """Raised when a route command was based on a stale persisted revision."""

    def __init__(self, *, plan_id: str, expected: int, actual: int):
        self.plan_id = plan_id
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"route plan revision conflict: expected {expected}, current revision is {actual}"
        )


class RoutePlanStore:
    def __init__(self, path: str | Path | None = None):
        self.path = path

    def save(
        self,
        plan: dict[str, Any],
        *,
        archive: bool = True,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        plan_id = str(plan.get("plan_id") or "").strip()
        workspace_id = str(plan.get("workspace_id") or "").strip()
        if not plan_id or not workspace_id:
            raise ValueError("plan_id and workspace_id are required")
        now = _now()
        with connect_database(self.path) as connection:
            # Serialize the read-increment-write sequence. A deferred SQLite
            # transaction lets concurrent writers read the same revision and
            # silently overwrite one another before either UPSERT commits.
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT revision, plan_json, created_at FROM route_plans WHERE id = ?",
                (plan_id,),
            ).fetchone()
            actual_revision = int(existing["revision"] or 0) if existing else 0
            if expected_revision is not None and expected_revision != actual_revision:
                raise RouteRevisionConflict(
                    plan_id=plan_id,
                    expected=expected_revision,
                    actual=actual_revision,
                )
            revision = actual_revision + 1
            created_at = str(existing["created_at"]) if existing else now
            updated_at = _next_workspace_timestamp(connection, workspace_id, now)
            stored = {
                **plan,
                "revision": revision,
                "created_at": created_at,
                "updated_at": updated_at,
            }
            if existing and archive:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO route_plan_revisions (
                        plan_id, revision, plan_json, archived_at
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (plan_id, int(existing["revision"]), str(existing["plan_json"]), now),
                )
            connection.execute(
                """
                INSERT INTO route_plans (
                    id, workspace_id, revision, active_candidate_id,
                    plan_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    revision = excluded.revision,
                    active_candidate_id = excluded.active_candidate_id,
                    plan_json = excluded.plan_json,
                    updated_at = excluded.updated_at
                """,
                (
                    plan_id,
                    workspace_id,
                    revision,
                    stored.get("active_candidate_id"),
                    json.dumps(stored, ensure_ascii=False, default=str),
                    created_at,
                    updated_at,
                ),
            )
        return stored

    def undo(self, plan_id: str, *, expected_revision: int | None = None) -> dict[str, Any] | None:
        """Restore and consume the latest prior snapshot as a new revision."""
        normalized_id = str(plan_id or "").strip()
        if not normalized_id:
            raise ValueError("plan_id is required")
        now = _now()
        with connect_database(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT workspace_id, revision, created_at FROM route_plans WHERE id = ?",
                (normalized_id,),
            ).fetchone()
            if not current:
                return None
            actual_revision = int(current["revision"] or 0)
            if expected_revision is not None and expected_revision != actual_revision:
                raise RouteRevisionConflict(
                    plan_id=normalized_id,
                    expected=expected_revision,
                    actual=actual_revision,
                )
            previous = connection.execute(
                """
                SELECT revision, plan_json FROM route_plan_revisions
                WHERE plan_id = ? ORDER BY revision DESC LIMIT 1
                """,
                (normalized_id,),
            ).fetchone()
            if not previous:
                return None
            restored = _json_object(previous["plan_json"])
            revision = actual_revision + 1
            workspace_id = str(current["workspace_id"])
            updated_at = _next_workspace_timestamp(connection, workspace_id, now)
            restored.update({
                "plan_id": normalized_id,
                "workspace_id": workspace_id,
                "revision": revision,
                "created_at": str(current["created_at"]),
                "updated_at": updated_at,
            })
            connection.execute(
                "DELETE FROM route_plan_revisions WHERE plan_id = ? AND revision = ?",
                (normalized_id, int(previous["revision"])),
            )
            connection.execute(
                """
                UPDATE route_plans SET
                    revision = ?, active_candidate_id = ?, plan_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    revision,
                    restored.get("active_candidate_id"),
                    json.dumps(restored, ensure_ascii=False, default=str),
                    updated_at,
                    normalized_id,
                ),
            )
        return restored

    def get(self, plan_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT plan_json FROM route_plans WHERE id = ?",
                (str(plan_id),),
            ).fetchone()
        return _json_object(row["plan_json"]) if row else None

    def get_latest(self, workspace_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                """
                SELECT plan_json FROM route_plans
                WHERE workspace_id = ?
                ORDER BY updated_at DESC, rowid DESC LIMIT 1
                """,
                (str(workspace_id),),
            ).fetchone()
        return _json_object(row["plan_json"]) if row else None


def _json_object(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="microseconds")


def _next_workspace_timestamp(connection, workspace_id: str, proposed: str) -> str:
    """Return a strictly increasing ISO timestamp within one workspace."""
    row = connection.execute(
        "SELECT MAX(updated_at) AS updated_at FROM route_plans WHERE workspace_id = ?",
        (workspace_id,),
    ).fetchone()
    latest = str(row["updated_at"] or "") if row else ""
    proposed_at = datetime.fromisoformat(proposed)
    if latest:
        latest_at = datetime.fromisoformat(latest)
        if proposed_at <= latest_at:
            proposed_at = latest_at + timedelta(microseconds=1)
    return proposed_at.isoformat(timespec="microseconds")
