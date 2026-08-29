"""Persistence owner for Rider saved routes and continuation progress.

The browser-facing API uses camelCase, but this repository deliberately keeps
SQLite details and route normalization behind one Python-owned boundary.  The
stored ``route_json`` remains a Rider domain object because it is the immutable
asset consumed directly by the virtual-ride UI.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from storage.database import connect_database


ROUTE_SOURCES = {"gpx", "agent", "map-draw", "exploration", "manual", "imported"}
SOURCE_ALIASES = {
    "agent-planned": "agent",
    "map-drawn": "map-draw",
    "osm-exploration": "exploration",
}
DOMAIN_SOURCES = {
    "agent": "agent-planned",
    "map-draw": "map-drawn",
    "exploration": "osm-exploration",
}


class SavedRouteNotFound(KeyError):
    """Raised when an operation targets a route that no longer exists."""


class SavedRouteStore:
    """Own saved route geometry and its independently mutable ride progress."""

    def __init__(self, path: str | Path | None = None):
        self.path = path

    def save_route(
        self,
        value: dict[str, Any],
        *,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        normalized = _normalize_saved_route(value)
        if connection is not None:
            return self._save_route(connection, normalized)
        with connect_database(self.path) as owned_connection:
            # Serialize the read/merge/upsert sequence. Without this lock, two
            # writers can both observe no row, choose different UUIDs and make
            # the conflict loser read back a route ID that was never inserted.
            owned_connection.execute("BEGIN IMMEDIATE")
            return self._save_route(owned_connection, normalized)

    def _save_route(
        self,
        connection: sqlite3.Connection,
        normalized: dict[str, Any],
    ) -> dict[str, Any]:
        now = _now()
        existing = connection.execute(
            """
            SELECT id, created_at, agent_plan_id, agent_candidate_id, metadata_json
            FROM saved_routes WHERE fingerprint = ?
            """,
            (normalized["fingerprint"],),
        ).fetchone()
        route_id = str(existing["id"] if existing else uuid4())
        created_at = str(existing["created_at"] if existing else now)
        agent_plan_id = normalized["agent_plan_id"] or (
            existing["agent_plan_id"] if existing else None
        )
        agent_candidate_id = normalized["agent_candidate_id"] or (
            existing["agent_candidate_id"] if existing else None
        )
        metadata = _json_object(existing["metadata_json"] if existing else None)
        metadata.update(normalized["metadata"])
        connection.execute(
            """
            INSERT INTO saved_routes (
                id, source, name, import_file_name, fingerprint, route_json,
                original_gpx_text, total_distance_meters,
                total_elevation_gain_meters, has_elevation_data,
                agent_plan_id, agent_candidate_id, metadata_json,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
                source = excluded.source,
                name = excluded.name,
                import_file_name = COALESCE(excluded.import_file_name, saved_routes.import_file_name),
                route_json = excluded.route_json,
                original_gpx_text = COALESCE(excluded.original_gpx_text, saved_routes.original_gpx_text),
                total_distance_meters = excluded.total_distance_meters,
                total_elevation_gain_meters = excluded.total_elevation_gain_meters,
                has_elevation_data = excluded.has_elevation_data,
                agent_plan_id = COALESCE(excluded.agent_plan_id, saved_routes.agent_plan_id),
                agent_candidate_id = COALESCE(excluded.agent_candidate_id, saved_routes.agent_candidate_id),
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at
            """,
            (
                route_id,
                normalized["source"],
                normalized["name"],
                normalized["import_file_name"],
                normalized["fingerprint"],
                _json(normalized["route"]),
                normalized["original_gpx_text"],
                normalized["total_distance_meters"],
                normalized["total_elevation_gain_meters"],
                int(normalized["has_elevation_data"]),
                agent_plan_id,
                agent_candidate_id,
                _json(metadata),
                created_at,
                now,
            ),
        )
        # A geometry duplicate may carry corrected distance metadata. Do not
        # leave continuation state beyond the replacement route end.
        connection.execute(
            """
            DELETE FROM route_progress
            WHERE route_id = ? AND resume_distance_meters >= ?
            """,
            (route_id, max(0.0, normalized["total_distance_meters"] - 10)),
        )
        route = self._read_route(connection, route_id)
        return {**(route or {}), "created": existing is None}

    def list_routes(self, *, source: str = "") -> list[dict[str, Any]]:
        values: tuple[Any, ...] = ()
        where = ""
        if source:
            where = " WHERE r.source = ?"
            values = (_normalize_source(source),)
        with connect_database(self.path) as connection:
            rows = connection.execute(
                f"{_ROUTE_SUMMARY_SQL}{where} ORDER BY r.updated_at DESC",
                values,
            ).fetchall()
        return [_route_summary(row) for row in rows]

    def get_route(self, route_id: str) -> dict[str, Any] | None:
        with connect_database(self.path) as connection:
            return self._read_route(connection, _normalize_id(route_id))

    def rename_route(self, route_id: str, name: str) -> dict[str, Any]:
        normalized_id = _normalize_id(route_id)
        normalized_name = _text(name, max_length=160)
        if not normalized_name:
            raise ValueError("Route name is required.")
        with connect_database(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = self._read_route(connection, normalized_id)
            if existing is None:
                raise SavedRouteNotFound("Saved route not found.")
            route_json = deepcopy(existing["route"])
            route_json["name"] = normalized_name
            result = connection.execute(
                "UPDATE saved_routes SET name = ?, route_json = ?, updated_at = ? WHERE id = ?",
                (normalized_name, _json(route_json), _now(), normalized_id),
            )
            if result.rowcount == 0:
                raise SavedRouteNotFound("Saved route not found.")
            route = self._read_route(connection, normalized_id)
        return route or _raise_not_found()

    def delete_route(self, route_id: str) -> dict[str, Any]:
        normalized_id = _normalize_id(route_id)
        with connect_database(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            route = self._read_route(connection, normalized_id)
            if route is None:
                raise SavedRouteNotFound("Saved route not found.")
            connection.execute("DELETE FROM saved_routes WHERE id = ?", (normalized_id,))
        return route

    def save_progress(
        self,
        route_id: str,
        *,
        resume_distance_meters: Any,
        last_activity_id: Any = None,
        started_at: Any = None,
    ) -> dict[str, Any]:
        normalized_id = _normalize_id(route_id)
        with connect_database(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            route = self._read_route(connection, normalized_id)
            if route is None:
                raise SavedRouteNotFound("Saved route not found.")
            total = _finite_or_zero(route["totalDistanceMeters"])
            distance = min(max(0.0, _finite_or_zero(resume_distance_meters)), total)
            if distance <= 0 or distance >= total - 10:
                connection.execute("DELETE FROM route_progress WHERE route_id = ?", (normalized_id,))
            else:
                connection.execute(
                    """
                    INSERT INTO route_progress (
                        route_id, resume_distance_meters, last_activity_id,
                        status, started_at, updated_at
                    ) VALUES (?, ?, ?, 'paused', ?, ?)
                    ON CONFLICT(route_id) DO UPDATE SET
                        resume_distance_meters = excluded.resume_distance_meters,
                        last_activity_id = excluded.last_activity_id,
                        status = excluded.status,
                        started_at = COALESCE(excluded.started_at, route_progress.started_at),
                        updated_at = excluded.updated_at
                    """,
                    (
                        normalized_id,
                        distance,
                        _optional_text(last_activity_id),
                        _optional_text(started_at),
                        _now(),
                    ),
                )
            updated = self._read_route(connection, normalized_id)
        return updated or _raise_not_found()

    def clear_progress(self, route_id: str) -> dict[str, Any]:
        normalized_id = _normalize_id(route_id)
        with connect_database(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if self._read_route(connection, normalized_id) is None:
                raise SavedRouteNotFound("Saved route not found.")
            connection.execute("DELETE FROM route_progress WHERE route_id = ?", (normalized_id,))
            route = self._read_route(connection, normalized_id)
        return route or _raise_not_found()

    @staticmethod
    def _read_route(connection: Any, route_id: str) -> dict[str, Any] | None:
        row = connection.execute(
            f"{_ROUTE_DETAIL_SQL} WHERE r.id = ? LIMIT 1",
            (route_id,),
        ).fetchone()
        if row is None:
            return None
        route = _json_object(row["routeJson"])
        if not route:
            return None
        route["source"] = _restore_domain_source(route.get("source"), row["source"])
        return {
            **_route_summary(row),
            "route": route,
            "originalGpxText": row["originalGpxText"],
        }


_ROUTE_SUMMARY_SQL = """
    SELECT r.id, r.source, r.name, r.import_file_name AS importFileName,
           r.total_distance_meters AS totalDistanceMeters,
           r.total_elevation_gain_meters AS totalElevationGainMeters,
           r.has_elevation_data AS hasElevationData,
           r.agent_plan_id AS agentPlanId,
           r.agent_candidate_id AS agentCandidateId,
           r.metadata_json AS metadataJson,
           r.created_at AS createdAt, r.updated_at AS updatedAt,
           p.resume_distance_meters AS resumeDistanceMeters,
           p.last_activity_id AS lastActivityId,
           p.status AS progressStatus, p.started_at AS progressStartedAt,
           p.updated_at AS progressUpdatedAt
    FROM saved_routes AS r
    LEFT JOIN route_progress AS p ON p.route_id = r.id
"""

_ROUTE_DETAIL_SQL = _ROUTE_SUMMARY_SQL.replace(
    "r.created_at AS createdAt, r.updated_at AS updatedAt,",
    "r.created_at AS createdAt, r.updated_at AS updatedAt, "
    "r.route_json AS routeJson, r.original_gpx_text AS originalGpxText,",
)


def _normalize_saved_route(value: dict[str, Any]) -> dict[str, Any]:
    route = value.get("route")
    if not isinstance(route, dict) or not isinstance(route.get("points"), list) or len(route["points"]) < 2:
        raise ValueError("A route with at least two coordinate points is required.")
    points = [deepcopy(point) for point in route["points"] if _valid_coordinate(point)]
    if len(points) < 2:
        raise ValueError("Route has no usable coordinates.")
    total_distance = _finite_or_zero(route.get("totalDistanceMeters"))
    if total_distance <= 0:
        raise ValueError("Route has no usable distance.")
    source = _normalize_source(value.get("source") or route.get("source"))
    name = _text(value.get("name") or route.get("name"), fallback="保存的路线", max_length=160)
    clean_route = deepcopy(route)
    clean_route.update({
        "source": _restore_domain_source(route.get("source"), source),
        "name": name,
        "points": points,
        "isDraft": False,
        "continuation": None,
    })
    clean_route.pop("savedRouteId", None)
    clean_route.pop("routeLibraryResumeDistanceMeters", None)
    return {
        "source": source,
        "name": name,
        "import_file_name": _optional_text(route.get("importFileName")),
        "fingerprint": _route_fingerprint(points),
        "route": clean_route,
        "original_gpx_text": value.get("originalGpxText") if isinstance(value.get("originalGpxText"), str) else None,
        "total_distance_meters": total_distance,
        "total_elevation_gain_meters": _finite_or_zero(route.get("totalElevationGainMeters")),
        "has_elevation_data": route.get("hasElevationData") is True,
        "agent_plan_id": _optional_text(value.get("agentPlanId") or route.get("agentPlanId")),
        "agent_candidate_id": _optional_text(value.get("agentCandidateId") or route.get("agentCandidateId")),
        "metadata": deepcopy(value.get("metadata")) if isinstance(value.get("metadata"), dict) else {},
    }


def _route_fingerprint(points: list[dict[str, Any]]) -> str:
    geometry = [[
        _javascript_fixed_6(_coordinate(point, "latitude", "lat")),
        _javascript_fixed_6(_coordinate(point, "longitude", "lng")),
    ] for point in points]
    payload = json.dumps(geometry, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _javascript_fixed_6(value: float) -> str:
    """Match Number.toFixed(6), including JavaScript's unsigned zero text."""
    rendered = f"{value:.6f}"
    return "0.000000" if rendered == "-0.000000" else rendered


def _route_summary(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "source": str(row["source"]),
        "name": str(row["name"]),
        "importFileName": row["importFileName"],
        "totalDistanceMeters": _finite_or_zero(row["totalDistanceMeters"]),
        "totalElevationGainMeters": _finite_or_zero(row["totalElevationGainMeters"]),
        "hasElevationData": bool(row["hasElevationData"]),
        "agentPlanId": row["agentPlanId"],
        "agentCandidateId": row["agentCandidateId"],
        "metadata": _json_object(row["metadataJson"]),
        "resumeDistanceMeters": _finite_or_zero(row["resumeDistanceMeters"]),
        "lastActivityId": row["lastActivityId"],
        "progressStatus": row["progressStatus"],
        "progressStartedAt": row["progressStartedAt"],
        "progressUpdatedAt": row["progressUpdatedAt"],
        "createdAt": str(row["createdAt"]),
        "updatedAt": str(row["updatedAt"]),
    }


def _normalize_source(value: Any) -> str:
    source = str(value or "").strip().lower()
    normalized = SOURCE_ALIASES.get(source, source)
    if normalized not in ROUTE_SOURCES:
        raise ValueError(f"Unsupported route source: {value}")
    return normalized


def _restore_domain_source(value: Any, stored_source: Any) -> str:
    source = str(value or "").strip().lower()
    if source in {"agent-planned", "map-drawn", "osm-exploration", "gpx", "manual"}:
        return source
    normalized = _normalize_source(stored_source or value)
    return DOMAIN_SOURCES.get(normalized, normalized)


def _normalize_id(value: Any) -> str:
    route_id = str(value or "").strip()
    if not route_id or len(route_id) > 128:
        raise ValueError("Route id is required.")
    return route_id


def _valid_coordinate(point: Any) -> bool:
    if not isinstance(point, dict):
        return False
    latitude = _coordinate(point, "latitude", "lat")
    longitude = _coordinate(point, "longitude", "lng")
    return math.isfinite(latitude) and math.isfinite(longitude) and abs(latitude) <= 90 and abs(longitude) <= 180


def _coordinate(point: dict[str, Any], primary: str, fallback: str) -> float:
    value = point.get(primary) if point.get(primary) is not None else point.get(fallback)
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def _finite_or_zero(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def _text(value: Any, fallback: str = "", max_length: int | None = None) -> str:
    text = str(value or "").strip()
    if max_length is not None:
        text = text[:max_length]
    return text or fallback


def _optional_text(value: Any) -> str | None:
    return _text(value) or None


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return deepcopy(value)
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _raise_not_found() -> Any:
    raise SavedRouteNotFound("Saved route not found.")
