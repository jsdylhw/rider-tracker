"""Durable single-user athlete profile storage."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from storage.database import connect_database


DEFAULT_PROFILE_ID = "default"
ATHLETE_PROFILE_SCHEMA_VERSION = "athlete_profile.v1"


class AthleteProfileStore:
    def __init__(self, path: str | Path | None = None):
        self.path = path

    def get_profile(self, profile_id: str = DEFAULT_PROFILE_ID) -> dict[str, Any]:
        with connect_database(self.path) as connection:
            row = connection.execute(
                "SELECT profile_json FROM athlete_profiles WHERE id = ?",
                (profile_id,),
            ).fetchone()
        if row is None:
            return {}
        try:
            profile = json.loads(str(row["profile_json"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
        return profile if isinstance(profile, dict) else {}

    def save_profile(
        self,
        profile: dict[str, Any],
        profile_id: str = DEFAULT_PROFILE_ID,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        payload = json.dumps(profile, ensure_ascii=False, sort_keys=True)
        with connect_database(self.path) as connection:
            existing = connection.execute(
                "SELECT created_at FROM athlete_profiles WHERE id = ?",
                (profile_id,),
            ).fetchone()
            created_at = str(existing["created_at"]) if existing else now
            connection.execute(
                """
                INSERT INTO athlete_profiles (
                    id, schema_version, profile_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    profile_json = excluded.profile_json,
                    updated_at = excluded.updated_at
                """,
                (profile_id, ATHLETE_PROFILE_SCHEMA_VERSION, payload, created_at, now),
            )
        return profile
