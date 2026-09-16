"""Structured failures shared by external provider adapters."""

from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError


class ProviderError(RuntimeError):
    """A provider returned an error or unusable response.

    The display message remains human-readable, while the stable attributes
    let services and the Agent decide whether to retry without parsing text.
    """

    def __init__(
        self,
        message: str,
        *,
        provider: str = "route_provider",
        stage: str = "provider_request",
        code: str = "provider_rejected",
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.stage = stage
        self.code = code
        self.retryable = retryable

    def to_failure(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "provider": self.provider,
            "stage": self.stage,
            "retryable": self.retryable,
            "message": str(self),
        }

    def to_tool_result(self) -> dict[str, Any]:
        """Adapt a direct provider failure at the Agent tool boundary."""
        return {
            "status": "failed",
            "error": self.code,
            **self.to_failure(),
        }


class TransientProviderError(ProviderError):
    """A retryable transport or temporary upstream failure."""

    def __init__(
        self,
        message: str,
        *,
        provider: str = "route_provider",
        stage: str = "provider_request",
        code: str = "provider_unavailable",
    ) -> None:
        super().__init__(
            message,
            provider=provider,
            stage=stage,
            code=code,
            retryable=True,
        )


def classify_http_error(
    exc: HTTPError,
    *,
    provider: str,
    stage: str,
    label: str,
) -> ProviderError:
    """Classify an HTTP failure without exposing an HTML proxy error page.

    Google APIs return structured JSON for request or credential errors. A
    non-JSON HTTP 400 observed after a successful CONNECT is instead an
    intermittent proxy/upstream edge response and is safe to retry within the
    provider's existing bounded retry loop.
    """
    try:
        raw = exc.read().decode("utf-8", errors="replace")
    except OSError:
        raw = ""
    payload: Any = None
    try:
        payload = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        payload = None

    transient = exc.code in {408, 429} or exc.code >= 500 or (exc.code == 400 and payload is None)
    if transient:
        detail = (
            "代理或上游网关返回了非 JSON 响应"
            if exc.code == 400 and payload is None
            else str(exc.reason or "temporary provider failure")
        )
        return TransientProviderError(
            f"{label} HTTP {exc.code}：{detail}",
            provider=provider,
            stage=stage,
        )

    detail = "provider rejected the request"
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict) and error.get("message"):
        detail = str(error["message"])
    elif isinstance(payload, dict) and payload.get("message"):
        detail = str(payload["message"])
    return ProviderError(
        f"{label} HTTP {exc.code}：{detail}",
        provider=provider,
        stage=stage,
        code="provider_http_error",
    )
