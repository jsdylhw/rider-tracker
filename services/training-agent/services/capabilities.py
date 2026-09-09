"""Training backend and optional LLM capability projection."""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "training_backend_capabilities.v1"


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
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "backend": "available",
        "llm": llm_status,
        "reason": reason,
        "capabilities": {
            "fit_ingestion": True,
            "activity_detail": True,
            "athlete_profile": True,
            "strava": True,
            "activity_analysis": llm_ready,
            "training_history": llm_ready,
            "ai_route_planning": llm_ready,
            "route_narration": llm_ready,
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
    return bool(normalized and not normalized.lower().startswith("replace-with"))
