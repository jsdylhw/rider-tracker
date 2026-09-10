"""Training backend and optional LLM capability projection."""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "training_backend_capabilities.v2"


def build_backend_capabilities(config: dict[str, Any] | None) -> dict[str, Any]:
    """Describe usable backend features without contacting external providers.

    The Python service can parse FIT files and own local integrations without an
    LLM key.  Keeping those capabilities separate prevents an optional model
    configuration from becoming a global Rider startup requirement.
    """
    values = config if isinstance(config, dict) else {}
    agent = values.get("agent") if isinstance(values.get("agent"), dict) else {}
    mode = _agent_mode(agent.get("enabled", "auto"))
    configured = all(_configured(agent.get(field)) for field in ("base_url", "api_key", "model"))
    if mode == "disabled":
        llm_status = "disabled"
        reason = "AI features are disabled by agent.enabled."
    elif not configured:
        llm_status = "not_configured"
        reason = "Configure agent.base_url, agent.api_key and agent.model to enable AI features."
    else:
        llm_status = "ready"
        reason = None
    llm_ready = llm_status == "ready"
    google = values.get("google") if isinstance(values.get("google"), dict) else {}
    amap = values.get("amap") if isinstance(values.get("amap"), dict) else {}
    strava = values.get("strava") if isinstance(values.get("strava"), dict) else {}
    athlete = values.get("athlete") if isinstance(values.get("athlete"), dict) else {}

    google_ready = _configured(google.get("api_key"))
    amap_ready = _configured(amap.get("web_service_key"))
    strava_configured = all(_configured(strava.get(field)) for field in ("client_id", "client_secret"))
    garmin_ready = all(_configured(values.get(field)) for field in ("garmin_username", "garmin_password"))
    athlete_fields = ("ftp", "weight_kg", "max_heart_rate", "resting_heart_rate")
    athlete_configured = sum(_configured(athlete.get(field)) for field in athlete_fields)
    athlete_status = "complete" if athlete_configured == len(athlete_fields) else (
        "partial" if athlete_configured else "missing"
    )

    providers = {
        "llm": {"status": llm_status, "reason": reason},
        "google": _provider_status(google_ready, "Configure google.api_key."),
        "amap": _provider_status(amap_ready, "Configure amap.web_service_key."),
        "strava": _provider_status(strava_configured, "Configure Strava client credentials, then authorize."),
        "garmin": _provider_status(garmin_ready, "Configure Garmin China credentials."),
        "athlete_profile": {
            "status": athlete_status,
            "reason": None if athlete_status == "complete" else "Complete FTP, weight and heart-rate settings for full metrics.",
        },
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "backend": "available",
        "llm": llm_status,
        "reason": reason,
        "providers": providers,
        "capabilities": {
            "fit_ingestion": True,
            "activity_detail": True,
            "athlete_profile": True,
            "strava": strava_configured,
            "garmin_sync": garmin_ready,
            "activity_analysis": llm_ready,
            "training_history": llm_ready,
            # Google is the product-level gate for online route experiences.
            # AMap remains an additional requirement for routes inside China.
            "ai_route_planning": llm_ready and google_ready,
            "domestic_ai_routes": llm_ready and google_ready and amap_ready,
            "international_ai_routes": llm_ready and google_ready,
            "map_waypoint_routes": google_ready,
            "map_exploration": google_ready,
            "street_view": google_ready,
            "google_elevation_reference": google_ready,
            "route_narration": llm_ready and google_ready,
            "imported_route_grade_simulation": True,
            "custom_workout": True,
        },
    }


def _agent_mode(value: Any) -> str:
    if isinstance(value, bool):
        return "enabled" if value else "disabled"
    normalized = str(value or "auto").strip().lower()
    if normalized in {"false", "off", "no", "0", "disabled"}:
        return "disabled"
    return "enabled" if normalized in {"true", "on", "yes", "1", "enabled"} else "auto"


def _configured(value: Any) -> bool:
    normalized = str(value or "").strip()
    lowered = normalized.lower()
    return bool(
        normalized
        and not lowered.startswith("replace-with")
        and not lowered.startswith("your-")
    )


def _provider_status(ready: bool, missing_reason: str) -> dict[str, Any]:
    return {
        "status": "ready" if ready else "missing",
        "reason": None if ready else missing_reason,
    }
