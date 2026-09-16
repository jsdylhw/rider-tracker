"""Structured failures shared by external provider adapters."""

from __future__ import annotations

from typing import Any


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
