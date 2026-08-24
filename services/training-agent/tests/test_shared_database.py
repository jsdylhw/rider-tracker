import json
import sqlite3

from storage.database import SCHEMA_VERSION, initialize_database
from storage.repositories.activity import ActivityStore


def test_migrates_rider_activity_catalog_without_losing_summary_only_rows(tmp_path):
    database = tmp_path / "rider.db"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE activities (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                sport_type TEXT NOT NULL,
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
                raw_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                fit_file_path TEXT,
                fit_file_size_bytes INTEGER,
                fit_file_created_at TEXT
            );
            CREATE TABLE saved_routes (
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
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT INTO activities (
                id, source, sport_type, name, has_gps_track, raw_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("ride-1", "rider-tracker", "VirtualRide", "Summary only", 0, "{}", "now", "now"),
        )
        connection.execute(
            """
            INSERT INTO saved_routes (
                id, source, name, fingerprint, route_json,
                total_distance_meters, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("route-1", "gpx", "Existing route", "fingerprint-1", "{}", 1000, "now", "now"),
        )
        initialize_database(connection)

        columns = {row[1] for row in connection.execute("PRAGMA table_info(activities)")}
        assert {
            "source_activity_id", "sub_sport", "strava_activity_id", "saved_route_id",
            "route_start_distance_meters", "route_end_distance_meters",
        } <= columns
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert connection.execute("SELECT COUNT(*) FROM activities").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM activity_reports").fetchone()[0] == 0
        route_columns = {row[1] for row in connection.execute("PRAGMA table_info(saved_routes)")}
        assert {"agent_plan_id", "agent_candidate_id", "metadata_json"} <= route_columns
        assert connection.execute("SELECT name FROM saved_routes WHERE id = 'route-1'").fetchone()[0] == "Existing route"
        assert connection.execute("SELECT COUNT(*) FROM route_progress").fetchone()[0] == 0

    entry = ActivityStore(database).get_activity("ride-1")
    assert entry is not None
    assert entry["activity_key"] == "ride-1"
    assert "fit_path" not in entry
    assert json.loads(sqlite3.connect(database).execute(
        "SELECT raw_json FROM activities WHERE id = 'ride-1'"
    ).fetchone()[0]) == {}
