"""Repository for the SQLite activity catalogue and current report documents."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from domain.contracts.schemas import ACTIVITY_FEATURES_V1, ACTIVITY_METRICS_V2
from domain.analysis.artifacts import (
    SUMMARY_SCHEMA_V2,
    build_history_view,
    get_analysis_summary,
    get_tss,
    summary_schema_version,
)
from project_paths import persisted_path_variants, portable_path_text, project_relative_or_absolute, resolve_project_path
from storage.database import connect_database
from domain.time import local_time_without_timezone


# Browser activity-library mutations have a 2 s proxy deadline.  Waiting less
# than that at the SQLite boundary guarantees a timed-out HTTP request cannot
# later acquire the lock and commit an unseen rename/delete.
ACTIVITY_MUTATION_BUSY_TIMEOUT_MS = 1_000


class ActivityStoreBusy(RuntimeError):
    """The activity catalogue could not acquire its write lock in time."""


class ActivityStore:
    """Persist one FIT activity, its deterministic facts and current report."""

    def __init__(self, path: str | Path | None = None):
        self.path = path

    def count_activities(self) -> int:
        with connect_database(self.path) as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM activities").fetchone()
        return int(row["count"] if row else 0)

    def get_rider_history(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        sport_type: str = "",
        source: str = "",
    ) -> dict[str, Any]:
        """Return the stable browser activity-list contract.

        Filtering applies to the page and its total.  Summary counters remain
        global, matching Rider's existing home dashboard semantics.
        """
        safe_limit = _clamp_integer(limit, minimum=1, maximum=200, fallback=50)
        safe_offset = _clamp_integer(offset, minimum=0, maximum=1_000_000, fallback=0)
        clauses: list[str] = []
        parameters: list[Any] = []
        normalized_sport = _filter_text(sport_type)
        normalized_source = _filter_text(source)
        if normalized_sport:
            clauses.append("sport_type = ?")
            parameters.append(normalized_sport)
        if normalized_source:
            clauses.append("source = ?")
            parameters.append(normalized_source)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

        with connect_database(self.path) as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM activities
                {where}
                ORDER BY COALESCE(started_at, created_at) DESC
                LIMIT ? OFFSET ?
                """,
                (*parameters, safe_limit, safe_offset),
            ).fetchall()
            total_row = connection.execute(
                f"SELECT COUNT(*) AS activity_count FROM activities {where}",
                parameters,
            ).fetchone()
            summary_row = connection.execute(
                """
                SELECT
                    COUNT(*) AS activity_count,
                    COALESCE(SUM(distance_km), 0) AS total_distance_km,
                    COALESCE(SUM(ascent_meters), 0) AS total_ascent_meters,
                    COALESCE(SUM(elapsed_seconds), 0) AS total_elapsed_seconds,
                    COALESCE(SUM(estimated_tss), 0) AS total_estimated_tss
                FROM activities
                """
            ).fetchone()

        total = int(total_row["activity_count"] if total_row else 0)
        activities = [_rider_activity(row) for row in rows]
        summary = _rider_activity_summary(summary_row)
        return {
            "activities": activities,
            "summary": summary,
            "page": {
                "total": total,
                "offset": safe_offset,
                "limit": safe_limit,
                "hasMore": safe_offset + len(activities) < total,
            },
        }

    def get_rider_activity(self, activity_id: str, *, include_raw_session: bool = False) -> dict[str, Any] | None:
        normalized_id = str(activity_id or "").strip()
        if not normalized_id:
            return None
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT * FROM activities WHERE id = ? LIMIT 1",
                (normalized_id,),
            ).fetchone()
        return _rider_activity(row, include_raw_session=include_raw_session) if row else None

    def archive_rider_session(
        self,
        activity: dict[str, Any],
        *,
        raw_session: dict[str, Any],
    ) -> dict[str, Any]:
        """Upsert a completed Rider session and route link atomically.

        FIT metadata and derived analysis rows are intentionally untouched. A
        later FIT ingestion can enrich this same stable activity ID.
        """
        activity_id = str(activity.get("id") or "").strip()
        if not activity_id or not isinstance(raw_session, dict):
            raise ValueError("Activity id and Rider session are required.")
        values = {
            **activity,
            "id": activity_id,
            "raw_json": json.dumps(raw_session, ensure_ascii=False, default=str),
        }
        try:
            with connect_database(
                self.path,
                busy_timeout_ms=ACTIVITY_MUTATION_BUSY_TIMEOUT_MS,
            ) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """
                    INSERT INTO activities (
                        id, source, sport_type, name, started_at, finished_at,
                        elapsed_seconds, distance_km, ascent_meters,
                        average_power, normalized_power, average_hr,
                        estimated_tss, has_gps_track, raw_json,
                        saved_route_id, route_start_distance_meters,
                        route_end_distance_meters, created_at, updated_at
                    ) VALUES (
                        :id, :source, :sport_type, :name, :started_at, :finished_at,
                        :elapsed_seconds, :distance_km, :ascent_meters,
                        :average_power, :normalized_power, :average_hr,
                        :estimated_tss, :has_gps_track, :raw_json,
                        :saved_route_id, :route_start_distance_meters,
                        :route_end_distance_meters, :created_at, :updated_at
                    )
                    ON CONFLICT(id) DO UPDATE SET
                        source = excluded.source,
                        sport_type = excluded.sport_type,
                        name = excluded.name,
                        started_at = excluded.started_at,
                        finished_at = excluded.finished_at,
                        elapsed_seconds = excluded.elapsed_seconds,
                        distance_km = excluded.distance_km,
                        ascent_meters = excluded.ascent_meters,
                        average_power = excluded.average_power,
                        normalized_power = excluded.normalized_power,
                        average_hr = excluded.average_hr,
                        estimated_tss = excluded.estimated_tss,
                        has_gps_track = excluded.has_gps_track,
                        raw_json = excluded.raw_json,
                        saved_route_id = CASE
                            WHEN excluded.saved_route_id IS NOT NULL THEN excluded.saved_route_id
                            ELSE activities.saved_route_id
                        END,
                        route_start_distance_meters = CASE
                            WHEN excluded.saved_route_id IS NOT NULL THEN excluded.route_start_distance_meters
                            ELSE activities.route_start_distance_meters
                        END,
                        route_end_distance_meters = CASE
                            WHEN excluded.saved_route_id IS NOT NULL THEN excluded.route_end_distance_meters
                            ELSE activities.route_end_distance_meters
                        END,
                        updated_at = excluded.updated_at
                    """,
                    values,
                )
                row = connection.execute(
                    "SELECT * FROM activities WHERE id = ? LIMIT 1",
                    (activity_id,),
                ).fetchone()
                if row is None:
                    raise RuntimeError("Archived Rider activity was not found.")
                stored = _rider_activity(row, include_raw_session=True)
        except sqlite3.OperationalError as exc:
            _raise_activity_store_busy(exc)
            raise
        return stored

    def save_fit_ingestion(
        self,
        entry: dict[str, Any],
        *,
        metrics: dict[str, Any],
        features: dict[str, Any],
        artifact_type: str,
        artifact_schema_version: str,
        artifact_input_hash: str,
        artifact_payload: dict[str, Any],
        route_link: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Atomically persist one parsed FIT and all deterministic derivatives.

        FIT decoding happens before this method.  The short write transaction
        owns the activity row, file metadata, facts, UI artifact and optional
        saved-route link so a failed ingestion cannot expose a partial result.
        Omitting ``route_link`` preserves any association created by the Rider
        session fallback.
        """
        _validate_fit_ingestion(entry, metrics=metrics, features=features)
        try:
            with connect_database(
                self.path,
                busy_timeout_ms=ACTIVITY_MUTATION_BUSY_TIMEOUT_MS,
            ) as connection:
                connection.execute("BEGIN IMMEDIATE")
                raw, rider_activity = _upsert_fit_activity_row(
                    connection, entry, route_link=route_link,
                )
                facts = _upsert_facts_row(
                    connection,
                    str(entry["activity_key"]),
                    metrics=metrics,
                    features=features,
                )
                _upsert_artifact_row(
                    connection,
                    str(entry["activity_key"]),
                    artifact_type=artifact_type,
                    schema_version=artifact_schema_version,
                    input_hash=artifact_input_hash,
                    payload=artifact_payload,
                )
        except sqlite3.OperationalError as exc:
            _raise_activity_store_busy(exc)
            raise
        except sqlite3.IntegrityError as exc:
            if "FOREIGN KEY" in str(exc).upper():
                raise ValueError("route_link.saved_route_id does not exist") from exc
            raise

        return {
            "activity": {
                **raw,
                "facts_schema_version": facts["schema_version"],
                "facts_revision": facts["revision"],
            },
            "rider_activity": rider_activity,
            "facts": facts,
        }

    def rename_rider_activity(self, activity_id: str, name: Any) -> dict[str, Any]:
        normalized_id = str(activity_id or "").strip()
        if not isinstance(name, str):
            raise ValueError("Activity name must be a string.")
        normalized_name = name.strip()[:120]
        if not normalized_id or not normalized_name:
            raise ValueError("Activity id and name are required.")
        try:
            with connect_database(
                self.path,
                busy_timeout_ms=ACTIVITY_MUTATION_BUSY_TIMEOUT_MS,
            ) as connection:
                cursor = connection.execute(
                    "UPDATE activities SET name = ?, updated_at = ? WHERE id = ?",
                    (normalized_name, _now(), normalized_id),
                )
                if cursor.rowcount == 0:
                    raise KeyError("Activity not found.")
        except sqlite3.OperationalError as exc:
            _raise_activity_store_busy(exc)
            raise
        activity = self.get_rider_activity(normalized_id)
        if activity is None:
            raise KeyError("Activity not found.")
        return activity

    def delete_rider_activity(self, activity_id: str) -> dict[str, Any]:
        normalized_id = str(activity_id or "").strip()
        if not normalized_id:
            raise ValueError("Activity id is required.")
        try:
            with connect_database(
                self.path,
                busy_timeout_ms=ACTIVITY_MUTATION_BUSY_TIMEOUT_MS,
            ) as connection:
                row = connection.execute(
                    "SELECT * FROM activities WHERE id = ? LIMIT 1",
                    (normalized_id,),
                ).fetchone()
                if row is None:
                    raise KeyError("Activity not found.")
                activity = _rider_activity(row)
                connection.execute("DELETE FROM activities WHERE id = ?", (normalized_id,))
        except sqlite3.OperationalError as exc:
            _raise_activity_store_busy(exc)
            raise
        return activity

    def find_activity_identity(
        self,
        *,
        fit_path: str | None = None,
        source: str | None = None,
        source_activity_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Resolve an existing stable identity before deriving a new FIT hash ID."""
        clauses: list[str] = []
        values: list[str] = []
        if fit_path:
            variants = persisted_path_variants(fit_path)
            clauses.append(f"fit_file_path IN ({','.join('?' for _ in variants)})")
            values.extend(variants)
        if source and source_activity_id:
            clauses.append("(source = ? AND source_activity_id = ?)")
            values.extend([str(source), str(source_activity_id)])
        if not clauses:
            return None
        with connect_database(self.path) as connection:
            row = connection.execute(
                f"SELECT id, source, source_activity_id, fit_file_path, name FROM activities WHERE {' OR '.join(clauses)} LIMIT 1",
                values,
            ).fetchone()
        if row is None:
            return None
        return {
            "activity_key": str(row["id"]),
            "source": str(row["source"]),
            "source_activity_id": row["source_activity_id"],
            "fit_path": row["fit_file_path"],
            "name": row["name"],
        }

    def upsert_activity(self, entry: dict[str, Any]) -> dict[str, Any]:
        activity_id = str(entry.get("activity_key") or "").strip()
        fit_path = portable_path_text(entry.get("fit_path") or "").strip()
        if not activity_id:
            raise ValueError("activity_key is required")
        if not fit_path:
            raise ValueError("fit_path is required")

        now = _now()
        with connect_database(self.path) as connection:
            # A FIT path identifies one immutable source row. A remote source
            # identity also owns only one current content-key row. Refreshes
            # discard stale derived facts/reports through the FK cascade.
            source = str(entry.get("source") or "manual")
            source_activity_id = _text(entry.get("source_activity_id"))
            stale_rows = _stale_fit_rows(connection, activity_id, fit_path, source, source_activity_id)
            for stale in stale_rows:
                connection.execute("DELETE FROM activities WHERE id = ?", (str(stale["id"]),))
            existing = connection.execute(
                "SELECT raw_json, created_at FROM activities WHERE id = ?",
                (activity_id,),
            ).fetchone()
            raw = _json_object(existing["raw_json"] if existing else None)
            raw.update({key: value for key, value in entry.items() if value is not None})
            raw["fit_path"] = fit_path
            for obsolete in ("summary_path", "training_load"):
                raw.pop(obsolete, None)
            values = _activity_values(raw, activity_id=activity_id, fit_path=fit_path, now=now)
            created_at = str(existing["created_at"]) if existing else now
            connection.execute(
                """
                INSERT INTO activities (
                    id, source, source_activity_id, sport_type, sub_sport, name,
                    started_at, finished_at, elapsed_seconds, distance_km,
                    ascent_meters, average_power, normalized_power, average_hr,
                    estimated_tss, has_gps_track, fit_file_path,
                    fit_file_size_bytes, fit_file_created_at, strava_activity_id,
                    raw_json, created_at, updated_at
                ) VALUES (
                    :id, :source, :source_activity_id, :sport_type, :sub_sport, :name,
                    :started_at, :finished_at, :elapsed_seconds, :distance_km,
                    :ascent_meters, :average_power, :normalized_power, :average_hr,
                    :estimated_tss, :has_gps_track, :fit_file_path,
                    :fit_file_size_bytes, :fit_file_created_at, :strava_activity_id,
                    :raw_json, :created_at, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                    source = excluded.source,
                    source_activity_id = excluded.source_activity_id,
                    sport_type = excluded.sport_type,
                    sub_sport = excluded.sub_sport,
                    name = excluded.name,
                    started_at = excluded.started_at,
                    finished_at = excluded.finished_at,
                    elapsed_seconds = excluded.elapsed_seconds,
                    distance_km = excluded.distance_km,
                    ascent_meters = excluded.ascent_meters,
                    average_power = excluded.average_power,
                    normalized_power = excluded.normalized_power,
                    average_hr = excluded.average_hr,
                    estimated_tss = excluded.estimated_tss,
                    has_gps_track = excluded.has_gps_track,
                    fit_file_path = excluded.fit_file_path,
                    fit_file_size_bytes = excluded.fit_file_size_bytes,
                    fit_file_created_at = excluded.fit_file_created_at,
                    strava_activity_id = excluded.strava_activity_id,
                    raw_json = excluded.raw_json,
                    updated_at = excluded.updated_at
                """,
                {**values, "created_at": created_at},
            )
        return raw

    def replace_activities(self, entries: Iterable[dict[str, Any]]) -> None:
        rows = [dict(entry) for entry in entries]
        with connect_database(self.path) as connection:
            connection.execute("DELETE FROM activities")
        for entry in rows:
            self.upsert_activity(entry)

    def clear(self) -> None:
        """Clear derived SQLite state while leaving every FIT/JSON source intact."""
        with connect_database(self.path) as connection:
            # activity_reports is removed by the foreign-key cascade.
            connection.execute("DELETE FROM activities")

    def list_activity_entries(self) -> list[dict[str, Any]]:
        with connect_database(self.path) as connection:
            rows = connection.execute(
                """
                SELECT a.*, r.schema_version AS report_schema_version,
                       r.status AS report_status, r.export_path,
                       r.analysis_json, r.strava_summary AS report_strava_summary,
                       f.schema_version AS facts_schema_version
                FROM activities AS a
                LEFT JOIN activity_reports AS r ON r.activity_id = a.id
                LEFT JOIN activity_facts AS f ON f.activity_id = a.id
                ORDER BY COALESCE(a.started_at, ''), a.name, a.id
                """
            ).fetchall()
        return [_activity_entry(row) for row in rows]

    def get_activity(self, activity_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                """
                SELECT a.*, r.schema_version AS report_schema_version,
                       r.status AS report_status, r.export_path,
                       r.analysis_json, r.strava_summary AS report_strava_summary,
                       f.schema_version AS facts_schema_version
                FROM activities AS a
                LEFT JOIN activity_reports AS r ON r.activity_id = a.id
                LEFT JOIN activity_facts AS f ON f.activity_id = a.id
                WHERE a.id = ?
                """,
                (str(activity_id),),
            ).fetchone()
        return _activity_entry(row) if row else None

    def get_activity_by_fit_path(self, fit_path: str | Path) -> dict[str, Any] | None:
        """Resolve the database row without relying on an activity index file."""
        variants = persisted_path_variants(fit_path)
        with connect_database(self.path) as connection:
            row = connection.execute(
                f"SELECT id FROM activities WHERE fit_file_path IN ({','.join('?' for _ in variants)})",
                variants,
            ).fetchone()
        return self.get_activity(str(row["id"])) if row else None

    def save_facts(self, activity_id: str, *, metrics: dict[str, Any], features: dict[str, Any]) -> dict[str, Any]:
        """Upsert import-time metrics/features without involving a LLM report."""
        activity_id = str(activity_id).strip()
        if self.get_activity(activity_id) is None:
            raise KeyError(f"activity must be indexed before saving facts: {activity_id}")
        if metrics.get("schema_version") != ACTIVITY_METRICS_V2:
            raise ValueError(f"metrics must use {ACTIVITY_METRICS_V2}")
        if features.get("schema_version") != ACTIVITY_FEATURES_V1:
            raise ValueError(f"features must use {ACTIVITY_FEATURES_V1}")

        with connect_database(self.path) as connection:
            return _upsert_facts_row(
                connection,
                activity_id,
                metrics=metrics,
                features=features,
            )

    def get_facts(self, activity_id: str) -> dict[str, Any] | None:
        """Read structured import-time facts for one immutable activity."""
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT * FROM activity_facts WHERE activity_id = ?",
                (str(activity_id),),
            ).fetchone()
        if not row:
            return None
        return {
            "activity_id": str(row["activity_id"]),
            "schema_version": str(row["schema_version"]),
            "extractor_version": str(row["extractor_version"]),
            "metrics": _json_object(row["metrics_json"]),
            "features": _json_object(row["features_json"]),
            "revision": int(row["revision"]),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }

    def save_report(
        self,
        document: dict[str, Any],
        *,
        export_path: str | Path | None = None,
    ) -> dict[str, Any]:
        with connect_database(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            return save_report_in_transaction(connection, document, export_path=export_path)

    def get_report(self, activity_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT report_json FROM activity_reports WHERE activity_id = ?",
                (str(activity_id),),
            ).fetchone()
        if not row:
            return None
        return _json_object(row["report_json"])

    def get_report_for_activity(self, activity: dict[str, Any]) -> dict[str, Any] | None:
        """Read by key while rejecting a stale key/path mismatch.

        Content hashes make collisions impossible in production, but this
        check also prevents a malformed import (and small unit-test keys) from
        binding a report to a different FIT path.
        """
        activity_id = str(activity.get("activity_key") or "")
        if not activity_id:
            return None
        stored_activity = self.get_activity(activity_id)
        if stored_activity is None:
            return None
        requested_fit = activity.get("fit_path")
        stored_fit = stored_activity.get("fit_path")
        if requested_fit and stored_fit and not _same_path(requested_fit, stored_fit):
            return None
        return self.get_report(activity_id)

    def get_report_record(self, activity_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT * FROM activity_reports WHERE activity_id = ?",
                (str(activity_id),),
            ).fetchone()
        return dict(row) if row else None

    def export_report(self, activity_id: str, path: str | Path) -> Path:
        """Materialize an explicit JSON export without making it runtime state."""
        report = self.get_report(activity_id)
        if report is None:
            raise KeyError(f"activity report not found: {activity_id}")
        target = Path(path).expanduser()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        with connect_database(self.path) as connection:
            connection.execute(
                "UPDATE activity_reports SET export_path = ?, updated_at = ? WHERE activity_id = ?",
                (str(target), _now(), str(activity_id)),
            )
        return target

    def query_history(
        self,
        *,
        before: str | None = None,
        days: int | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Build history from imported metrics, not generated report prose."""
        before_dt = _parse_datetime(before) if before else None
        after_dt = before_dt - timedelta(days=int(days)) if before_dt and days else None
        rows: list[dict[str, Any]] = []
        for activity in self.list_activity_entries():
            started_at = _parse_datetime(activity.get("start_time_local"))
            if before_dt and started_at and started_at >= before_dt:
                continue
            if after_dt and started_at and started_at < after_dt:
                continue
            facts = self.get_facts(str(activity.get("activity_key") or ""))
            metrics = facts.get("metrics") if isinstance(facts, dict) else None
            if isinstance(metrics, dict) and metrics.get("schema_version") == "activity_metrics.v2":
                rows.append(_history_view_from_metrics(activity, metrics))
                continue
            # Compatibility for databases created before import-time facts.
            # New code never chooses prose/report data when facts are present.
            report = self.get_report(str(activity.get("activity_key") or ""))
            if report is not None:
                rows.append(build_history_view(report))
        rows.sort(key=lambda row: str(row.get("start_time") or ""))
        if limit:
            rows = rows[-int(limit):]
        return {
            "kind": "activity_facts_history",
            "before": before,
            "days": days,
            "limit": limit,
            "count": len(rows),
            "activities": rows,
        }

    def report_counts(self) -> dict[str, int]:
        with connect_database(self.path) as connection:
            rows = connection.execute(
                "SELECT schema_version, COUNT(*) AS count FROM activity_reports GROUP BY schema_version"
            ).fetchall()
        return {str(row["schema_version"]): int(row["count"]) for row in rows}

    def save_artifact(
        self,
        activity_key: str,
        *,
        artifact_type: str,
        schema_version: str,
        input_hash: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        with connect_database(self.path) as connection:
            return _upsert_artifact_row(
                connection,
                activity_key,
                artifact_type=artifact_type,
                schema_version=schema_version,
                input_hash=input_hash,
                payload=payload,
            )

    def get_artifact(self, activity_key: str, artifact_type: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT * FROM activity_artifacts WHERE activity_id = ? AND artifact_type = ?",
                (activity_key, artifact_type),
            ).fetchone()
        if row is None:
            return None
        return {
            "activity_key": str(row["activity_id"]),
            "artifact_type": str(row["artifact_type"]),
            "schema_version": str(row["schema_version"]),
            "input_hash": str(row["input_hash"]),
            "payload": _json_object(row["payload_json"]),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }


def _validate_fit_ingestion(
    entry: dict[str, Any],
    *,
    metrics: dict[str, Any],
    features: dict[str, Any],
) -> None:
    if not str(entry.get("activity_key") or "").strip() or not str(entry.get("fit_path") or "").strip():
        raise ValueError("activity_key and fit_path are required")
    if metrics.get("schema_version") != ACTIVITY_METRICS_V2:
        raise ValueError(f"metrics must use {ACTIVITY_METRICS_V2}")
    if features.get("schema_version") != ACTIVITY_FEATURES_V1:
        raise ValueError(f"features must use {ACTIVITY_FEATURES_V1}")


def _upsert_fit_activity_row(
    connection: sqlite3.Connection,
    entry: dict[str, Any],
    *,
    route_link: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    activity_id = str(entry["activity_key"]).strip()
    fit_path = portable_path_text(entry["fit_path"]).strip()
    source = str(entry.get("source") or "manual")
    source_activity_id = _text(entry.get("source_activity_id"))
    stale_rows = _stale_fit_rows(connection, activity_id, fit_path, source, source_activity_id)
    for stale in stale_rows:
        connection.execute("DELETE FROM activities WHERE id = ?", (str(stale["id"]),))

    now = _now()
    existing = connection.execute(
        "SELECT raw_json, created_at FROM activities WHERE id = ?",
        (activity_id,),
    ).fetchone()
    raw = _json_object(existing["raw_json"] if existing else None)
    raw.update({key: value for key, value in entry.items() if value is not None})
    raw["fit_path"] = fit_path
    for obsolete in ("summary_path", "training_load"):
        raw.pop(obsolete, None)
    values = _activity_values(raw, activity_id=activity_id, fit_path=fit_path, now=now)
    normalized_route = _normalize_fit_route_link(route_link)
    if normalized_route["replace_route_link"]:
        saved_route = connection.execute(
            "SELECT 1 FROM saved_routes WHERE id = ? LIMIT 1",
            (normalized_route["saved_route_id"],),
        ).fetchone()
        if saved_route is None:
            raise ValueError("route_link.saved_route_id does not exist")
    values.update(normalized_route)
    created_at = str(existing["created_at"]) if existing else now
    connection.execute(
        """
        INSERT INTO activities (
            id, source, source_activity_id, sport_type, sub_sport, name,
            started_at, finished_at, elapsed_seconds, distance_km,
            ascent_meters, average_power, normalized_power, average_hr,
            estimated_tss, has_gps_track, fit_file_path,
            fit_file_size_bytes, fit_file_created_at, strava_activity_id,
            raw_json, saved_route_id, route_start_distance_meters,
            route_end_distance_meters, created_at, updated_at
        ) VALUES (
            :id, :source, :source_activity_id, :sport_type, :sub_sport, :name,
            :started_at, :finished_at, :elapsed_seconds, :distance_km,
            :ascent_meters, :average_power, :normalized_power, :average_hr,
            :estimated_tss, :has_gps_track, :fit_file_path,
            :fit_file_size_bytes, :fit_file_created_at, :strava_activity_id,
            :raw_json, :saved_route_id, :route_start_distance_meters,
            :route_end_distance_meters, :created_at, :updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            source = excluded.source,
            source_activity_id = excluded.source_activity_id,
            sport_type = excluded.sport_type,
            sub_sport = excluded.sub_sport,
            name = excluded.name,
            started_at = excluded.started_at,
            finished_at = excluded.finished_at,
            elapsed_seconds = excluded.elapsed_seconds,
            distance_km = excluded.distance_km,
            ascent_meters = excluded.ascent_meters,
            average_power = excluded.average_power,
            normalized_power = excluded.normalized_power,
            average_hr = excluded.average_hr,
            estimated_tss = excluded.estimated_tss,
            has_gps_track = excluded.has_gps_track,
            fit_file_path = excluded.fit_file_path,
            fit_file_size_bytes = excluded.fit_file_size_bytes,
            fit_file_created_at = excluded.fit_file_created_at,
            strava_activity_id = excluded.strava_activity_id,
            raw_json = excluded.raw_json,
            saved_route_id = CASE
                WHEN :replace_route_link = 1 THEN excluded.saved_route_id
                ELSE activities.saved_route_id
            END,
            route_start_distance_meters = CASE
                WHEN :replace_route_link = 1 THEN excluded.route_start_distance_meters
                ELSE activities.route_start_distance_meters
            END,
            route_end_distance_meters = CASE
                WHEN :replace_route_link = 1 THEN excluded.route_end_distance_meters
                ELSE activities.route_end_distance_meters
            END,
            updated_at = excluded.updated_at
        """,
        {**values, "created_at": created_at},
    )
    row = connection.execute(
        "SELECT * FROM activities WHERE id = ? LIMIT 1",
        (activity_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError("Ingested FIT activity was not found.")
    return raw, _rider_activity(row)


def _upsert_facts_row(
    connection: sqlite3.Connection,
    activity_id: str,
    *,
    metrics: dict[str, Any],
    features: dict[str, Any],
) -> dict[str, Any]:
    now = _now()
    canonical = json.dumps(
        {"metrics": metrics, "features": features},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    input_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    existing = connection.execute(
        "SELECT revision, input_hash, created_at FROM activity_facts WHERE activity_id = ?",
        (activity_id,),
    ).fetchone()
    revision = int(existing["revision"] or 0) if existing else 0
    if not existing or str(existing["input_hash"] or "") != input_hash:
        revision += 1
    created_at = str(existing["created_at"]) if existing else now
    connection.execute(
        """
        INSERT INTO activity_facts (
            activity_id, schema_version, extractor_version, metrics_json,
            features_json, input_hash, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            extractor_version = excluded.extractor_version,
            metrics_json = excluded.metrics_json,
            features_json = excluded.features_json,
            input_hash = excluded.input_hash,
            revision = excluded.revision,
            updated_at = excluded.updated_at
        """,
        (
            activity_id,
            str(features["schema_version"]),
            str(features.get("extractor_version") or "unknown"),
            json.dumps(metrics, ensure_ascii=False, default=str),
            json.dumps(features, ensure_ascii=False, default=str),
            input_hash,
            revision,
            created_at,
            now,
        ),
    )
    return {
        "activity_id": activity_id,
        "revision": revision,
        "schema_version": features["schema_version"],
    }


def _upsert_artifact_row(
    connection: sqlite3.Connection,
    activity_id: str,
    *,
    artifact_type: str,
    schema_version: str,
    input_hash: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    now = _now()
    existing = connection.execute(
        """
        SELECT created_at FROM activity_artifacts
        WHERE activity_id = ? AND artifact_type = ?
        """,
        (activity_id, artifact_type),
    ).fetchone()
    created_at = str(existing["created_at"]) if existing else now
    connection.execute(
        """
        INSERT INTO activity_artifacts (
            activity_id, artifact_type, schema_version, input_hash,
            payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id, artifact_type) DO UPDATE SET
            schema_version = excluded.schema_version,
            input_hash = excluded.input_hash,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        """,
        (
            activity_id,
            artifact_type,
            schema_version,
            input_hash,
            json.dumps(payload, ensure_ascii=False, default=str),
            created_at,
            now,
        ),
    )
    return {
        "activity_key": activity_id,
        "artifact_type": artifact_type,
        "schema_version": schema_version,
        "input_hash": input_hash,
        "payload": payload,
        "created_at": created_at,
        "updated_at": now,
    }


def entry_from_fit_summary(
    fit_path: str | Path,
    summary: dict[str, Any],
    *,
    source: str = "manual",
    source_activity_id: str | None = None,
    activity_key: str | None = None,
) -> dict[str, Any]:
    fit = Path(fit_path).expanduser()
    started_at = local_time_without_timezone(summary.get("start_time_local") or summary.get("start_time"))
    duration = _number(summary.get("duration_s"))
    distance_m = _number(summary.get("distance_m"))
    return _without_none({
        "activity_key": activity_key or file_content_key(fit),
        "fit_path": project_relative_or_absolute(fit),
        "file_name": fit.name,
        "sport_type": summary.get("sport_type") or "unknown",
        "sub_sport": summary.get("sub_sport"),
        "start_time_local": started_at,
        "date_local": str(started_at)[:10] if started_at else None,
        "duration_s": duration,
        "distance_m": distance_m,
        "duration_min": round(duration / 60, 2) if duration is not None else None,
        "distance_km": round(distance_m / 1000, 3) if distance_m is not None else None,
        "source": source,
        "source_activity_id": source_activity_id,
        "has_summary": False,
        "has_strava_summary": False,
    })


def file_content_key(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def _stale_fit_rows(connection, activity_id, fit_path, source, source_activity_id):
    variants = persisted_path_variants(fit_path)
    clauses = [f"fit_file_path IN ({','.join('?' for _ in variants)})"]
    values = [activity_id, *variants]
    if source_activity_id:
        clauses.append("(source = ? AND source_activity_id = ?)")
        values.extend((source, source_activity_id))
    return connection.execute(
        f"SELECT id FROM activities WHERE id <> ? AND ({' OR '.join(clauses)})", values,
    ).fetchall()


def _activity_values(raw: dict[str, Any], *, activity_id: str, fit_path: str, now: str) -> dict[str, Any]:
    path = resolve_project_path(fit_path)
    started_at = raw.get("start_time_local") or raw.get("started_at")
    return {
        "id": activity_id,
        "source": str(raw.get("source") or "manual"),
        "source_activity_id": _text(raw.get("source_activity_id")),
        "sport_type": str(raw.get("sport_type") or "unknown"),
        "sub_sport": _text(raw.get("sub_sport")),
        "name": str(raw.get("name") or raw.get("file_name") or path.stem or activity_id),
        "started_at": _text(started_at),
        "finished_at": _text(raw.get("finished_at")),
        "elapsed_seconds": _number(raw.get("duration_s"), raw.get("elapsed_seconds")),
        "distance_km": _number(raw.get("distance_km"), _divide(raw.get("distance_m"), 1000)),
        "ascent_meters": _number(raw.get("ascent_meters"), raw.get("total_ascent")),
        "average_power": _number(raw.get("average_power"), raw.get("avg_power")),
        "normalized_power": _number(raw.get("normalized_power"), raw.get("normalized_power_w")),
        "average_hr": _number(raw.get("average_hr"), raw.get("avg_heart_rate")),
        "estimated_tss": _number(raw.get("estimated_tss"), raw.get("tss")),
        "has_gps_track": 1 if bool(raw.get("has_gps_track")) else 0,
        "fit_file_path": fit_path,
        "fit_file_size_bytes": path.stat().st_size if path.exists() else raw.get("fit_file_size_bytes"),
        "fit_file_created_at": (
            datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
            if path.exists()
            else _text(raw.get("fit_file_created_at"))
        ),
        "strava_activity_id": _text(raw.get("strava_activity_id")),
        "raw_json": json.dumps({**raw, "fit_path": fit_path}, ensure_ascii=False, default=str),
        "updated_at": now,
    }


def _activity_entry(row: Any) -> dict[str, Any]:
    raw = _json_object(row["raw_json"])
    fit_path = row["fit_file_path"]
    raw.update(_without_none({
        "activity_key": row["id"],
        "fit_path": fit_path,
        "file_name": raw.get("file_name") or (Path(str(fit_path)).name if fit_path else None),
        "source": row["source"],
        "source_activity_id": row["source_activity_id"],
        "sport_type": row["sport_type"],
        "sub_sport": row["sub_sport"],
        "name": row["name"],
        "start_time_local": row["started_at"],
        "date_local": str(row["started_at"])[:10] if row["started_at"] else None,
        "duration_s": row["elapsed_seconds"],
        "duration_min": _divide(row["elapsed_seconds"], 60),
        "distance_km": row["distance_km"],
        "distance_m": float(row["distance_km"]) * 1000 if row["distance_km"] is not None else None,
        "ascent_meters": row["ascent_meters"],
        "average_power": row["average_power"],
        "normalized_power": row["normalized_power"],
        "average_hr": row["average_hr"],
        "estimated_tss": row["estimated_tss"],
        "has_gps_track": bool(row["has_gps_track"]),
        "strava_activity_id": row["strava_activity_id"],
    }))
    has_report = row["report_schema_version"] is not None
    analysis = _json_object(row["analysis_json"])
    raw.update({
        "has_summary": has_report,
        "has_facts": row["facts_schema_version"] is not None,
        "facts_schema_version": row["facts_schema_version"],
        "has_strava_summary": bool(row["report_strava_summary"]) if has_report else False,
        "summary_schema_version": row["report_schema_version"] if has_report else None,
        "status": row["report_status"] if has_report else raw.get("status"),
        "summary_label": analysis.get("summary_label") if has_report else raw.get("summary_label"),
        "main_stimulus": analysis.get("main_stimulus") if has_report else raw.get("main_stimulus"),
        "load_label": analysis.get("load_label") if has_report else raw.get("load_label"),
    })
    raw.pop("training_load", None)
    raw.pop("summary_path", None)
    return _without_none(raw)


def _rider_activity(row: Any, *, include_raw_session: bool = False) -> dict[str, Any]:
    activity = {
        "id": str(row["id"]),
        "source": str(row["source"]),
        "sportType": str(row["sport_type"]),
        "subSport": row["sub_sport"],
        "name": str(row["name"]),
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "elapsedSeconds": _number(row["elapsed_seconds"]),
        "distanceKm": _number(row["distance_km"]),
        "ascentMeters": _number(row["ascent_meters"]),
        "averagePower": _number(row["average_power"]),
        "normalizedPower": _number(row["normalized_power"]),
        "averageHr": _number(row["average_hr"]),
        "estimatedTss": _number(row["estimated_tss"]),
        "hasGpsTrack": bool(row["has_gps_track"]),
        "fitFilePath": row["fit_file_path"],
        "fitFileSizeBytes": _number(row["fit_file_size_bytes"]),
        "fitFileCreatedAt": row["fit_file_created_at"],
        "savedRouteId": row["saved_route_id"],
        "routeStartDistanceMeters": _number(row["route_start_distance_meters"]),
        "routeEndDistanceMeters": _number(row["route_end_distance_meters"]),
        "createdAt": str(row["created_at"]),
        "updatedAt": str(row["updated_at"]),
    }
    if include_raw_session:
        activity["rawSession"] = _json_object(row["raw_json"])
    return activity


def _rider_activity_summary(row: Any) -> dict[str, int | float]:
    if row is None:
        return {
            "activityCount": 0,
            "totalDistanceKm": 0,
            "totalAscentMeters": 0,
            "totalElapsedSeconds": 0,
            "totalEstimatedTss": 0,
        }
    return {
        "activityCount": int(row["activity_count"] or 0),
        "totalDistanceKm": float(row["total_distance_km"] or 0),
        "totalAscentMeters": float(row["total_ascent_meters"] or 0),
        "totalElapsedSeconds": float(row["total_elapsed_seconds"] or 0),
        "totalEstimatedTss": float(row["total_estimated_tss"] or 0),
    }


def _filter_text(value: Any) -> str:
    return str(value).strip()[:120] if isinstance(value, str) else ""


def _normalize_fit_route_link(value: dict[str, Any] | None) -> dict[str, Any]:
    if value is None:
        return {
            "replace_route_link": 0,
            "saved_route_id": None,
            "route_start_distance_meters": None,
            "route_end_distance_meters": None,
        }
    if not isinstance(value, dict):
        raise ValueError("route_link must be an object")
    saved_route_id = _text(value.get("saved_route_id"))
    start = _number(value.get("start_distance_meters"))
    end = _number(value.get("end_distance_meters"))
    if not saved_route_id:
        raise ValueError("route_link.saved_route_id is required")
    if start is None or end is None or start < 0 or end < start:
        raise ValueError("route_link distance window is invalid")
    return {
        "replace_route_link": 1,
        "saved_route_id": saved_route_id[:128],
        "route_start_distance_meters": start,
        "route_end_distance_meters": end,
    }


def _clamp_integer(value: Any, *, minimum: int, maximum: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return min(maximum, max(minimum, number))


def _history_view_from_metrics(activity: dict[str, Any], metrics: dict[str, Any]) -> dict[str, Any]:
    """Build a compact, fact-only history row for optional child-agent context."""
    identity = metrics.get("identity") if isinstance(metrics.get("identity"), dict) else {}
    scale = metrics.get("scale") if isinstance(metrics.get("scale"), dict) else {}
    power = metrics.get("power") if isinstance(metrics.get("power"), dict) else {}
    heart_rate = metrics.get("heart_rate") if isinstance(metrics.get("heart_rate"), dict) else {}
    return _without_none({
        "kind": "activity_facts_history",
        "activity_key": metrics.get("activity_key") or activity.get("activity_key"),
        "file_path": activity.get("fit_path"),
        "start_time": identity.get("start_time_local") or activity.get("start_time_local"),
        "start_time_local": identity.get("start_time_local") or activity.get("start_time_local"),
        "sport_type": identity.get("sport_type") or activity.get("sport_type"),
        "sub_sport": identity.get("sub_sport") or activity.get("sub_sport"),
        "duration_min": scale.get("duration_min"),
        "distance_km": scale.get("distance_km"),
        "normalized_power_w": power.get("normalized_power_w"),
        "intensity_factor": power.get("intensity_factor"),
        "avg_hr_bpm": heart_rate.get("avg_hr_bpm"),
        "tss": get_tss(metrics),
        "metrics_source": "activity_facts",
    })


def _activity_enrichment_from_report(document: dict[str, Any]) -> dict[str, Any]:
    metrics = document.get("activity_metrics") if isinstance(document.get("activity_metrics"), dict) else {}
    power = metrics.get("power") if isinstance(metrics.get("power"), dict) else {}
    fit_summary = document.get("fit_summary") if isinstance(document.get("fit_summary"), dict) else {}
    analysis = get_analysis_summary(document)
    return _without_none({
        "activity_key": document.get("activity_key"),
        "fit_path": document.get("fit_path"),
        "sport_type": fit_summary.get("sport_type"),
        "sub_sport": fit_summary.get("sub_sport"),
        "start_time_local": fit_summary.get("start_time_local") or fit_summary.get("start_time"),
        "duration_s": fit_summary.get("duration_s"),
        "distance_m": fit_summary.get("distance_m"),
        "average_power": fit_summary.get("avg_power"),
        "normalized_power": power.get("normalized_power_w"),
        "average_hr": fit_summary.get("avg_heart_rate"),
        "estimated_tss": get_tss(metrics),
        "has_summary": True,
        "has_strava_summary": bool(document.get("strava_summary")),
        "strava_activity_id": document.get("strava_activity_id"),
        "summary_schema_version": summary_schema_version(document),
        "summary_label": analysis.get("summary_label"),
        "main_stimulus": analysis.get("main_stimulus"),
        "load_label": analysis.get("load_label"),
    })


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _number(*values: Any) -> float | None:
    for value in values:
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _divide(value: Any, denominator: float) -> float | None:
    number = _number(value)
    return number / denominator if number is not None else None


def _text(value: Any) -> str | None:
    return str(value) if value not in (None, "") else None


def _without_none(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def _raise_activity_store_busy(error: sqlite3.OperationalError) -> None:
    message = str(error).lower()
    if "locked" in message or "busy" in message:
        raise ActivityStoreBusy("Activity library is busy. Retry the operation.") from error


def _same_path(left: Any, right: Any) -> bool:
    try:
        return resolve_project_path(str(left)) == resolve_project_path(str(right))
    except (OSError, ValueError):
        return str(left).replace("\\", "/") == str(right).replace("\\", "/")


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed
    local_tz = datetime.now().astimezone().tzinfo
    return parsed.astimezone(local_tz).replace(tzinfo=None)


def save_report_in_transaction(connection, document, *, export_path=None):
    """Save report and catalogue enrichment in the caller-owned short transaction."""
    document = dict(document)
    for obsolete in ("summary_path", "history_entry", "history_before"):
        document.pop(obsolete, None)
    activity_id = str(document.get("activity_key") or "").strip()
    if not activity_id:
        raise ValueError("report activity_key is required")
    activity_row = connection.execute("""SELECT a.*,r.schema_version report_schema_version,
        r.status report_status,r.export_path,r.analysis_json,r.strava_summary report_strava_summary,
        f.schema_version facts_schema_version FROM activities a
        LEFT JOIN activity_reports r ON r.activity_id=a.id LEFT JOIN activity_facts f ON f.activity_id=a.id
        WHERE a.id=?""", (activity_id,)).fetchone()
    if activity_row is None:
        raise KeyError(f"activity must be indexed before saving its report: {activity_id}")

    schema = summary_schema_version(document)
    if schema != SUMMARY_SCHEMA_V2:
        raise ValueError(f"unsupported report schema: {document.get('schema_version')!r}")
    now = _now()
    metrics = document.get("activity_metrics") if isinstance(document.get("activity_metrics"), dict) else {}
    if metrics.get("schema_version") != ACTIVITY_METRICS_V2:
        raise ValueError(f"report activity_metrics must use {ACTIVITY_METRICS_V2}")
    analysis = get_analysis_summary(document)
    canonical = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    input_hash = str(document.get("input_hash") or hashlib.sha256(canonical.encode("utf-8")).hexdigest())
    existing = connection.execute(
        "SELECT revision, created_at, input_hash, export_path FROM activity_reports WHERE activity_id = ?",
        (activity_id,),
    ).fetchone()
    stored_export_path = (
        str(Path(export_path).expanduser())
        if export_path is not None
        else (str(existing["export_path"]) if existing and existing["export_path"] else None)
    )
    revision = int(existing["revision"] or 0) if existing else 0
    if not existing or str(existing["input_hash"] or "") != input_hash:
        revision += 1
    created_at = str(existing["created_at"]) if existing else now
    connection.execute(
        """
        INSERT INTO activity_reports (
            activity_id, schema_version, status, metrics_json, analysis_json,
            markdown_report, strava_summary, model, prompt_version, input_hash,
            revision, export_path, report_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            status = excluded.status,
            metrics_json = excluded.metrics_json,
            analysis_json = excluded.analysis_json,
            markdown_report = excluded.markdown_report,
            strava_summary = excluded.strava_summary,
            model = excluded.model,
            prompt_version = excluded.prompt_version,
            input_hash = excluded.input_hash,
            revision = excluded.revision,
            export_path = excluded.export_path,
            report_json = excluded.report_json,
            updated_at = excluded.updated_at
        """,
        (
            activity_id,
            schema,
            str(document.get("status") or "completed"),
            json.dumps(metrics, ensure_ascii=False, default=str),
            json.dumps(analysis, ensure_ascii=False, default=str),
            document.get("markdown_report"),
            document.get("strava_summary"),
            document.get("model"),
            document.get("prompt_version"),
            input_hash,
            revision,
            stored_export_path,
            json.dumps(document, ensure_ascii=False, default=str),
            created_at,
            now,
        ),
    )
    activity = _activity_entry(activity_row)
    activity.update(_activity_enrichment_from_report(document))
    fit_path = portable_path_text(activity["fit_path"])
    values = _activity_values(activity, activity_id=activity_id, fit_path=fit_path, now=now)
    fields = [key for key in values if key != "id"]
    connection.execute(
        f"UPDATE activities SET {','.join(key + '=:' + key for key in fields)} WHERE id=:id", values,
    )
    return {"activity_id": activity_id, "schema_version": schema, "revision": revision, "export_path": stored_export_path}
