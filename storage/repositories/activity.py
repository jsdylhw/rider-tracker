"""Repository for the SQLite activity catalogue and current report documents."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from domain.analysis.artifacts import (
    SUMMARY_SCHEMA_V2,
    build_history_view,
    get_analysis_summary,
    get_tss,
    summary_schema_version,
)
from storage.paths import project_relative_or_absolute
from storage.database import connect_database
from domain.time import local_time_without_timezone


class ActivityStore:
    """Persist one FIT activity, its deterministic facts and current report."""

    def __init__(self, path: str | Path | None = None):
        self.path = path

    def count_activities(self) -> int:
        with connect_database(self.path) as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM activities").fetchone()
        return int(row["count"] if row else 0)

    def upsert_activity(self, entry: dict[str, Any]) -> dict[str, Any]:
        activity_id = str(entry.get("activity_key") or "").strip()
        fit_path = str(entry.get("fit_path") or "").strip()
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
            if source_activity_id:
                stale_rows = connection.execute(
                    """
                    SELECT id FROM activities
                    WHERE id <> ? AND (
                        fit_file_path = ? OR (source = ? AND source_activity_id = ?)
                    )
                    """,
                    (activity_id, fit_path, source, source_activity_id),
                ).fetchall()
            else:
                stale_rows = connection.execute(
                    "SELECT id FROM activities WHERE fit_file_path = ? AND id <> ?",
                    (fit_path, activity_id),
                ).fetchall()
            for stale in stale_rows:
                connection.execute("DELETE FROM activities WHERE id = ?", (str(stale["id"]),))
            existing = connection.execute(
                "SELECT raw_json, created_at FROM activities WHERE id = ?",
                (activity_id,),
            ).fetchone()
            raw = _json_object(existing["raw_json"] if existing else None)
            raw.update({key: value for key, value in entry.items() if value is not None})
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
        value = str(fit_path)
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT id FROM activities WHERE fit_file_path = ?",
                (value,),
            ).fetchone()
        return self.get_activity(str(row["id"])) if row else None

    def save_facts(self, activity_id: str, *, metrics: dict[str, Any], features: dict[str, Any]) -> dict[str, Any]:
        """Upsert import-time metrics/features without involving a LLM report."""
        activity_id = str(activity_id).strip()
        if self.get_activity(activity_id) is None:
            raise KeyError(f"activity must be indexed before saving facts: {activity_id}")
        if metrics.get("schema_version") != "activity_metrics.v2":
            raise ValueError("metrics must use activity_metrics.v2")
        if features.get("schema_version") != "activity_features.v1":
            raise ValueError("features must use activity_features.v1")

        now = _now()
        extractor_version = str(features.get("extractor_version") or "unknown")
        canonical = json.dumps(
            {"metrics": metrics, "features": features},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        input_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        with connect_database(self.path) as connection:
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
                    extractor_version,
                    json.dumps(metrics, ensure_ascii=False, default=str),
                    json.dumps(features, ensure_ascii=False, default=str),
                    input_hash,
                    revision,
                    created_at,
                    now,
                ),
            )
        return {"activity_id": activity_id, "revision": revision, "schema_version": features["schema_version"]}

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
        document = dict(document)
        for obsolete in ("summary_path", "history_entry", "history_before"):
            document.pop(obsolete, None)
        activity_id = str(document.get("activity_key") or "").strip()
        if not activity_id:
            raise ValueError("report activity_key is required")
        if self.get_activity(activity_id) is None:
            raise KeyError(f"activity must be indexed before saving its report: {activity_id}")

        schema = summary_schema_version(document)
        if schema != SUMMARY_SCHEMA_V2:
            raise ValueError(f"unsupported report schema: {document.get('schema_version')!r}")
        now = _now()
        metrics = document.get("activity_metrics") if isinstance(document.get("activity_metrics"), dict) else {}
        if metrics.get("schema_version") != "activity_metrics.v2":
            raise ValueError("report activity_metrics must use activity_metrics.v2")
        analysis = get_analysis_summary(document)
        canonical = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        input_hash = str(document.get("input_hash") or hashlib.sha256(canonical.encode("utf-8")).hexdigest())
        with connect_database(self.path) as connection:
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

        activity = self.get_activity(activity_id) or {}
        activity.update(_activity_enrichment_from_report(document))
        self.upsert_activity(activity)
        return {
            "activity_id": activity_id,
            "schema_version": schema,
            "revision": revision,
            "export_path": stored_export_path,
        }

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
            "schema_version": "activity_facts_history.v1",
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


def _activity_values(raw: dict[str, Any], *, activity_id: str, fit_path: str, now: str) -> dict[str, Any]:
    path = Path(fit_path).expanduser()
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
        "raw_json": json.dumps(raw, ensure_ascii=False, default=str),
        "updated_at": now,
    }


def _activity_entry(row: Any) -> dict[str, Any]:
    raw = _json_object(row["raw_json"])
    raw.update(_without_none({
        "activity_key": row["id"],
        "fit_path": row["fit_file_path"],
        "file_name": raw.get("file_name") or Path(str(row["fit_file_path"])).name,
        "source": row["source"],
        "source_activity_id": row["source_activity_id"],
        "sport_type": row["sport_type"],
        "sub_sport": row["sub_sport"],
        "start_time_local": row["started_at"],
        "date_local": str(row["started_at"])[:10] if row["started_at"] else None,
        "duration_s": row["elapsed_seconds"],
        "duration_min": _divide(row["elapsed_seconds"], 60),
        "distance_km": row["distance_km"],
        "distance_m": float(row["distance_km"]) * 1000 if row["distance_km"] is not None else None,
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


def _history_view_from_metrics(activity: dict[str, Any], metrics: dict[str, Any]) -> dict[str, Any]:
    """Build a compact, fact-only history row for optional child-agent context."""
    identity = metrics.get("identity") if isinstance(metrics.get("identity"), dict) else {}
    scale = metrics.get("scale") if isinstance(metrics.get("scale"), dict) else {}
    power = metrics.get("power") if isinstance(metrics.get("power"), dict) else {}
    heart_rate = metrics.get("heart_rate") if isinstance(metrics.get("heart_rate"), dict) else {}
    return _without_none({
        "schema_version": "activity_facts_history.v1",
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


def _same_path(left: Any, right: Any) -> bool:
    try:
        return Path(str(left)).expanduser().resolve() == Path(str(right)).expanduser().resolve()
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
