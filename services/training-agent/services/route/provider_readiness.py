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


def use_amap_routes(country_code: str, config: dict[str, Any]) -> bool:
    """Allow a reversible Google experiment without changing the route country."""
    override = str(config.get("route_provider_override") or "auto").strip().lower()
    if override not in {"auto", "google"}:
        raise ValueError("route_provider_override must be auto or google")
    return country_code.upper() == "CN" and override != "google"
