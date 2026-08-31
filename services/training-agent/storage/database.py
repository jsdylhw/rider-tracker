"""SQLite connection and schema management.

The schema intentionally mirrors Rider Tracker's activity columns.  FIT files
remain immutable files on disk; SQLite owns their metadata and all generated
report state.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from project_paths import DEFAULT_PROJECT_ROOT, runtime_paths

# Compatibility export only. Actual connections call runtime_paths() so
# environment/config overrides are never frozen at module import time.
DEFAULT_DATABASE_PATH = DEFAULT_PROJECT_ROOT / "data" / "rider-tracker.db"
SCHEMA_VERSION = 9


def database_path(path: str | Path | None = None) -> Path:
    if path is not None:
        return Path(path).expanduser()
    target = runtime_paths().database
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def connect_database(
    path: str | Path | None = None,
    *,
    busy_timeout_ms: int = 30_000,
) -> sqlite3.Connection:
    target = database_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    normalized_busy_timeout_ms = max(0, int(busy_timeout_ms))
    connection = sqlite3.connect(target, timeout=normalized_busy_timeout_ms / 1000)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(f"PRAGMA busy_timeout = {normalized_busy_timeout_ms}")
    if not _managed_database():
        initialize_database(connection)
    return connection


def initialize_database(connection: sqlite3.Connection) -> None:
    _ensure_activity_catalog(connection)
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS activities (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            source_activity_id TEXT,
            sport_type TEXT NOT NULL,
            sub_sport TEXT,
            name TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            elapsed_seconds REAL,
            distance_km REAL,
            ascent_meters REAL,
            average_power REAL,
            normalized_power REAL,
            average_hr REAL,
            estimated_tss REAL,
            has_gps_track INTEGER NOT NULL DEFAULT 0,
            fit_file_path TEXT UNIQUE,
            fit_file_size_bytes INTEGER,
            fit_file_created_at TEXT,
            strava_activity_id TEXT,
            raw_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_activities_started_at
            ON activities(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activities_source
            ON activities(source, source_activity_id);
        CREATE INDEX IF NOT EXISTS idx_activities_sport_type
            ON activities(sport_type, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activities_saved_route
            ON activities(saved_route_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS activity_reports (
            activity_id TEXT PRIMARY KEY,
            schema_version TEXT NOT NULL,
            status TEXT NOT NULL,
            metrics_json TEXT NOT NULL DEFAULT '{}',
            analysis_json TEXT NOT NULL DEFAULT '{}',
            markdown_report TEXT,
            strava_summary TEXT,
            model TEXT,
            prompt_version TEXT,
            input_hash TEXT,
            revision INTEGER NOT NULL DEFAULT 1,
            export_path TEXT,
            report_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_activity_reports_schema_version
            ON activity_reports(schema_version, updated_at DESC);

        -- Import-time deterministic facts are deliberately independent from
        -- generated reports.  They can be rebuilt when detector algorithms
        -- change and remain available even if no LLM report exists yet.
        CREATE TABLE IF NOT EXISTS activity_facts (
            activity_id TEXT PRIMARY KEY,
            schema_version TEXT NOT NULL,
            extractor_version TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            features_json TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_activity_facts_schema_version
            ON activity_facts(schema_version, updated_at DESC);

        -- Rebuildable UI artifacts keep chart/map payloads out of the activity
        -- catalogue while avoiding a full FIT decode on every detail view.
        CREATE TABLE IF NOT EXISTS activity_artifacts (
            activity_id TEXT NOT NULL,
            artifact_type TEXT NOT NULL,
            schema_version TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(activity_id, artifact_type),
            FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_activity_artifacts_schema_version
            ON activity_artifacts(artifact_type, schema_version, updated_at DESC);

        -- One canonical athlete profile feeds both Rider simulation settings
        -- and deterministic FIT analysis thresholds.
        CREATE TABLE IF NOT EXISTS athlete_profiles (
            id TEXT PRIMARY KEY,
            schema_version TEXT NOT NULL,
            profile_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Analysis navigation is intentionally separate from chat history.  It
        -- freezes concrete activity/segment targets so a later CLI process can
        -- resume "the second one" without resolving a different recent set.
        CREATE TABLE IF NOT EXISTS analysis_navigation (
            workspace_id TEXT PRIMARY KEY,
            root_scope_json TEXT,
            focus_stack_json TEXT NOT NULL DEFAULT '[]',
            last_result_id TEXT,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Focused results are not full activity reports.  Keeping them in a
        -- separate table prevents a one-off question from overwriting the
        -- canonical report and lets the answer survive an LLM disconnect.
        CREATE TABLE IF NOT EXISTS analysis_results (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            request_json TEXT NOT NULL,
            target_json TEXT NOT NULL,
            result_json TEXT NOT NULL,
            status TEXT NOT NULL,
            input_hash TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_analysis_results_workspace
            ON analysis_results(workspace_id, updated_at DESC);

        -- Route plans keep provider geometry outside the model conversation.
        -- The mutable row stores the latest revision; prior snapshots support
        -- deterministic conversational undo without replaying chat payloads.
        CREATE TABLE IF NOT EXISTS route_plans (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            active_candidate_id TEXT,
            plan_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_route_plans_workspace
            ON route_plans(workspace_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS route_plan_revisions (
            plan_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            plan_json TEXT NOT NULL,
            archived_at TEXT NOT NULL,
            PRIMARY KEY(plan_id, revision),
            FOREIGN KEY(plan_id) REFERENCES route_plans(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_route_plan_revisions_plan
            ON route_plan_revisions(plan_id, revision DESC);

        -- Saved routes are Rider product assets. Agent route plans remain
        -- editable drafts until one candidate is explicitly confirmed here.
        CREATE TABLE IF NOT EXISTS saved_routes (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            name TEXT NOT NULL,
            import_file_name TEXT,
            fingerprint TEXT NOT NULL UNIQUE,
            route_json TEXT NOT NULL,
            original_gpx_text TEXT,
            total_distance_meters REAL NOT NULL,
            total_elevation_gain_meters REAL NOT NULL DEFAULT 0,
            has_elevation_data INTEGER NOT NULL DEFAULT 0,
            agent_plan_id TEXT,
            agent_candidate_id TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_saved_routes_updated_at
            ON saved_routes(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_saved_routes_source
            ON saved_routes(source, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_saved_routes_agent_candidate
            ON saved_routes(agent_plan_id, agent_candidate_id);

        -- Mutable continuation state is separate from immutable route geometry.
        CREATE TABLE IF NOT EXISTS route_progress (
            route_id TEXT PRIMARY KEY,
            resume_distance_meters REAL NOT NULL DEFAULT 0,
            last_activity_id TEXT,
            status TEXT NOT NULL DEFAULT 'paused',
            started_at TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(route_id) REFERENCES saved_routes(id) ON DELETE CASCADE,
            FOREIGN KEY(last_activity_id) REFERENCES activities(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_route_progress_updated_at
            ON route_progress(updated_at DESC);

        -- Web chat state is compact but durable.  Domain artifacts remain in
        -- their dedicated tables; this row restores the transcript, activity
        -- focus, retry state, and request-id idempotency after a process restart.
        CREATE TABLE IF NOT EXISTS chat_sessions (
            session_id TEXT PRIMARY KEY,
            context_json TEXT NOT NULL,
            responses_json TEXT NOT NULL DEFAULT '[]',
            updated_at REAL NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at
            ON chat_sessions(updated_at DESC);
        """
    )
    connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    connection.commit()


def _ensure_activity_catalog(connection: sqlite3.Connection) -> None:
    """Create or expand the shared Rider/Agent activity catalogue."""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS activities (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            source_activity_id TEXT,
            sport_type TEXT NOT NULL,
            sub_sport TEXT,
            name TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            elapsed_seconds REAL,
            distance_km REAL,
            ascent_meters REAL,
            average_power REAL,
            normalized_power REAL,
            average_hr REAL,
            estimated_tss REAL,
            has_gps_track INTEGER NOT NULL DEFAULT 0,
            fit_file_path TEXT,
            fit_file_size_bytes INTEGER,
            fit_file_created_at TEXT,
            strava_activity_id TEXT,
            raw_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    existing = {
        str(row[1]) for row in connection.execute("PRAGMA table_info(activities)").fetchall()
    }
    for name, definition in (
        ("source_activity_id", "TEXT"),
        ("sub_sport", "TEXT"),
        ("fit_file_path", "TEXT"),
        ("fit_file_size_bytes", "INTEGER"),
        ("fit_file_created_at", "TEXT"),
        ("strava_activity_id", "TEXT"),
        ("saved_route_id", "TEXT"),
        ("route_start_distance_meters", "REAL"),
        ("route_end_distance_meters", "REAL"),
    ):
        if name not in existing:
            connection.execute(f"ALTER TABLE activities ADD COLUMN {name} {definition}")
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_fit_file_path_unique
        ON activities(fit_file_path) WHERE fit_file_path IS NOT NULL
        """
    )
    _ensure_saved_route_columns(connection)


def _ensure_saved_route_columns(connection: sqlite3.Connection) -> None:
    """Expand the earlier GPX-only route table without losing saved routes."""
    existing = {
        str(row[1]) for row in connection.execute("PRAGMA table_info(saved_routes)").fetchall()
    }
    if not existing:
        return
    for name, definition in (
        ("agent_plan_id", "TEXT"),
        ("agent_candidate_id", "TEXT"),
        ("metadata_json", "TEXT NOT NULL DEFAULT '{}'"),
    ):
        if name not in existing:
            connection.execute(f"ALTER TABLE saved_routes ADD COLUMN {name} {definition}")


def _managed_database() -> bool:
    return os.environ.get("TRAINING_AGENT_MANAGED_DATABASE", "").strip().lower() in {
        "1", "true", "yes", "on",
    }
