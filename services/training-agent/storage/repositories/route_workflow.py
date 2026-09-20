"""Durable request-scoped route checkpoints; not authorization to replay tools."""
import json

from storage.database import connect_database


class RouteWorkflowStore:
    def save(self, snapshot):
        with connect_database() as connection:
            connection.execute(
                """INSERT INTO route_workflows (workspace_id, request_id, snapshot_json)
                   VALUES (?, ?, ?) ON CONFLICT(workspace_id, request_id)
                   DO UPDATE SET snapshot_json = excluded.snapshot_json""",
                (snapshot["workspace_id"], snapshot["request_id"], json.dumps(snapshot, ensure_ascii=False)),
            )

    def get(self, workspace_id, request_id):
        with connect_database() as connection:
            row = connection.execute(
                "SELECT snapshot_json FROM route_workflows WHERE workspace_id = ? AND request_id = ?",
                (workspace_id, request_id),
            ).fetchone()
        return json.loads(row[0]) if row else None
