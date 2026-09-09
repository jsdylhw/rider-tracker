"""Persistent cache for the current athlete's Strava route catalogue.

Only route summaries are cached here. Full GPX geometry is fetched on demand
and then stored through ``SavedRouteStore`` when the rider imports a route.
"""

from __future__ import annotations

import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from project_paths import runtime_paths


CATALOG_SCHEMA_VERSION = "strava_route_catalog.v1"


class StravaRouteCatalogStore:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path is not None else runtime_paths().cache_dir / "strava-routes.json"

    def load(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"routes": [], "cachedAt": None, "hasCache": False}
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            return {"routes": [], "cachedAt": None, "hasCache": False}
        if not isinstance(payload, dict) or payload.get("schemaVersion") != CATALOG_SCHEMA_VERSION:
            return {"routes": [], "cachedAt": None, "hasCache": False}
        routes = payload.get("routes") if isinstance(payload.get("routes"), list) else []
        return {
            "routes": [deepcopy(route) for route in routes if isinstance(route, dict)],
            "cachedAt": payload.get("cachedAt"),
            "hasCache": True,
        }

    def replace(self, routes: list[dict[str, Any]]) -> dict[str, Any]:
        normalized = [deepcopy(route) for route in routes if isinstance(route, dict)]
        cached_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        payload = {
            "schemaVersion": CATALOG_SCHEMA_VERSION,
            "cachedAt": cached_at,
            "routes": normalized,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                json.dump(payload, temporary, ensure_ascii=False, separators=(",", ":"))
                temporary.flush()
                os.fsync(temporary.fileno())
                temporary_path = Path(temporary.name)
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()
        return {"routes": normalized, "cachedAt": cached_at, "hasCache": True}
