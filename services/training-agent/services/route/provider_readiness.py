"""Provider readiness checks shared by route-planning use cases."""

from __future__ import annotations

from typing import Any

from integrations.google_connectivity import ensure_google_route_connectivity


def ensure_google_route_provider_ready(config: dict[str, Any]) -> None:
    google = config.get("google") if isinstance(config.get("google"), dict) else {}
    key = str(google.get("api_key") or "").strip()
    if not key or key.startswith("replace-with-"):
        raise ValueError("google.api_key is not configured")
    ensure_google_route_connectivity()
