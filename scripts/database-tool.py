#!/usr/bin/env python3
"""Explicit one-time initialization and migration for the shared SQLite database."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = PROJECT_ROOT / "services" / "training-agent"
sys.path.insert(0, str(AGENT_ROOT))

from project_paths import runtime_paths  # noqa: E402
from storage.database import SCHEMA_VERSION, initialize_database  # noqa: E402


REQUIRED_TABLES = {
    "activities",
    "activity_reports",
    "activity_facts",
    "activity_artifacts",
    "athlete_profiles",
    "analysis_navigation",
    "analysis_results",
    "route_plans",
    "route_plan_revisions",
    "saved_routes",
    "route_progress",
    "chat_sessions",
}
REQUIRED_ACTIVITY_COLUMNS = {
    "id", "source", "source_activity_id", "sport_type", "sub_sport", "name",
    "fit_file_path", "strava_activity_id", "raw_json", "created_at", "updated_at",
    "saved_route_id", "route_start_distance_meters", "route_end_distance_meters",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("init", "migrate", "check", "ensure"))
    parser.add_argument(
        "--database",
        default=str(runtime_paths(base=PROJECT_ROOT).database),
    )
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    target = Path(args.database).expanduser().resolve()

    if args.operation == "check":
        result = check_database(target)
    elif args.operation == "ensure":
        result = ensure_database(target)
    else:
        result = initialize_or_migrate(target, backup=args.operation == "migrate")
    if not args.quiet:
        print(json.dumps(result, ensure_ascii=False, indent=2))


def ensure_database(target: Path) -> dict[str, object]:
    """Make startup usable without running a migration on every launch."""
    if not target.is_file():
        result = initialize_or_migrate(target, backup=False)
        result["startup_action"] = "initialized"
        return result
    try:
        result = check_database(target)
        result["operation"] = "ensure"
        result["startup_action"] = "none"
        return result
    except SystemExit:
        result = initialize_or_migrate(target, backup=True)
        result["startup_action"] = "migrated"
        return result


def initialize_or_migrate(target: Path, *, backup: bool) -> dict[str, object]:
    target.parent.mkdir(parents=True, exist_ok=True)
    backup_path = None
    if backup and target.exists() and target.stat().st_size:
        timestamp = datetime.now().astimezone().strftime("%Y%m%dT%H%M%S")
        backup_path = target.with_name(f"{target.name}.backup-{timestamp}")
        with sqlite3.connect(target) as source, sqlite3.connect(backup_path) as destination:
            source.backup(destination)

    with sqlite3.connect(target, timeout=30) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        initialize_database(connection)

    result = check_database(target)
    result.update({
        "operation": "migrate" if backup else "init",
        "backup_path": str(backup_path) if backup_path else None,
    })
    return result


def check_database(target: Path) -> dict[str, object]:
    if not target.is_file():
        raise SystemExit(f"Database does not exist: {target}. Run npm run db:init first.")
    with sqlite3.connect(target, timeout=30) as connection:
        connection.row_factory = sqlite3.Row
        tables = {
            str(row[0]) for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(activities)").fetchall()
        }
        version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        missing_tables = sorted(REQUIRED_TABLES - tables)
        missing_columns = sorted(REQUIRED_ACTIVITY_COLUMNS - columns)
        if version != SCHEMA_VERSION or missing_tables or missing_columns:
            raise SystemExit(
                f"Database schema mismatch: version={version}, "
                f"missing_tables={missing_tables}, missing_activity_columns={missing_columns}. "
                "Run npm run db:migrate."
            )
        counts = {
            table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in sorted(REQUIRED_TABLES)
        }
    return {
        "status": "ok",
        "database_path": str(target),
        "schema_version": version,
        "counts": counts,
    }


if __name__ == "__main__":
    main()
