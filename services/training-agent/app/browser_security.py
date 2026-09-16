"""Security policy shared by Python's incremental browser-facing API surface."""

from __future__ import annotations

import hmac
import os
from typing import Any
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse


_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "testserver"}


def reject_untrusted_browser_request(
    request: Request,
    config: dict[str, Any] | None,
) -> JSONResponse | None:
    """Reject DNS-rebinding and cross-origin browser access to local APIs.

    Requests carrying the configured API token are server-to-server or explicit
    remote API clients and retain the existing token-based access contract.
    Browser requests normally carry no token, so their Host and optional Origin
    must resolve to the configured local Rider surface.
    """
    if not request.url.path.startswith("/api/"):
        return None

    values = config if isinstance(config, dict) else {}
    configured_token = str(values.get("web_api_token") or "")
    supplied_token = request.headers.get("X-API-Token", "")
    if configured_token and hmac.compare_digest(supplied_token, configured_token):
        return None

    host = _hostname(request.headers.get("host", ""))
    allowed_hosts = _allowed_hosts(values)
    if not host or host not in allowed_hosts:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "Invalid local API host."},
        )

    origin = str(request.headers.get("origin") or "").rstrip("/")
    if origin and origin not in _allowed_origins(values, allowed_hosts):
        return JSONResponse(
            status_code=403,
            content={"ok": False, "error": "Cross-origin local API access is not allowed."},
        )
    return None


def _allowed_hosts(config: dict[str, Any]) -> set[str]:
    hosts = set(_LOOPBACK_HOSTS)
    rider = config.get("rider") if isinstance(config.get("rider"), dict) else {}
    for value in (
        rider.get("host"),
        os.environ.get("HOST"),
        os.environ.get("PERSONAL_FIT_AGENT_HOST"),
    ):
        normalized = str(value or "").strip().strip("[]").lower()
        if normalized and normalized not in {"0.0.0.0", "::", "*"}:
            hosts.add(normalized)
    for value in (rider.get("app_base_url"), os.environ.get("APP_BASE_URL")):
        parsed = _url(value)
        if parsed and parsed.hostname:
            hosts.add(parsed.hostname.lower())
    return hosts


def _allowed_origins(
    config: dict[str, Any],
    allowed_hosts: set[str],
) -> set[str]:
    rider = config.get("rider") if isinstance(config.get("rider"), dict) else {}
    ports = {
        str(value)
        for value in (
            rider.get("port"),
            os.environ.get("PORT"),
            os.environ.get("PERSONAL_FIT_AGENT_PORT"),
            8787,
            8000,
        )
        if value not in (None, "")
    }
    origins = {
        f"http://{_url_host(host)}:{port}"
        for host in allowed_hosts
        if host != "testserver"
        for port in ports
    }
    for value in (rider.get("app_base_url"), os.environ.get("APP_BASE_URL")):
        parsed = _url(value)
        if parsed and parsed.scheme in {"http", "https"} and parsed.netloc:
            origins.add(f"{parsed.scheme}://{parsed.netloc}")

    return {value.rstrip("/") for value in origins}


def _hostname(value: Any) -> str:
    parsed = _url(f"//{str(value or '').strip()}")
    return str(parsed.hostname or "").lower() if parsed else ""


def _url(value: Any):
    try:
        return urlsplit(str(value or ""))
    except ValueError:
        return None


def _url_host(host: str) -> str:
    return f"[{host}]" if ":" in host else host
