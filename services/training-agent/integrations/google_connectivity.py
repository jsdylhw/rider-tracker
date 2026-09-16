"""Bounded connectivity preflight for Google route providers."""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from integrations.provider_error import TransientProviderError


GOOGLE_ROUTE_ENDPOINTS = (
    ("google_places", "https://places.googleapis.com/v1/places:searchText"),
    ("google_routes", "https://routes.googleapis.com/directions/v2:computeRoutes"),
)
ProbeTransport = Callable[[Request, float], Any]


def ensure_google_route_connectivity(
    *,
    attempts: int = 3,
    timeout_s: float = 8.0,
    retry_delay_s: float = 0.4,
    endpoints: Sequence[tuple[str, str]] = GOOGLE_ROUTE_ENDPOINTS,
    transport: ProbeTransport | None = None,
) -> dict[str, Any]:
    """Verify the proxy/TLS path before route planning starts.

    Any HTTP response proves that DNS, proxy and TLS negotiation succeeded;
    the real authenticated request remains responsible for interpreting API
    status codes. A proxy-authentication response is the exception because the
    configured network path cannot carry the subsequent provider request.
    """
    maximum_attempts = max(1, int(attempts))
    request_timeout = max(0.1, float(timeout_s))
    delay = max(0.0, float(retry_delay_s))
    probe = transport or _probe_endpoint
    endpoint_results: dict[str, dict[str, Any]] = {}

    for provider, url in endpoints:
        last_reason = "unknown network error"
        connected = False
        attempts_used = 0
        for attempt in range(1, maximum_attempts + 1):
            attempts_used = attempt
            try:
                probe(Request(url, method="HEAD"), request_timeout)
                connected = True
                break
            except (TimeoutError, URLError, OSError) as exc:
                last_reason = _safe_network_reason(exc)
                if attempt < maximum_attempts:
                    time.sleep(delay * attempt)
        endpoint_results[provider] = {
            "connected": connected,
            "attempts": attempts_used,
            "reason": "connected" if connected else last_reason,
        }

    if all(result["connected"] for result in endpoint_results.values()):
        return {
            "provider": "google",
            "stage": "connection_preflight",
            "endpoints": endpoint_results,
        }

    summary = "；".join(
        f"{provider}：{result['attempts']} 次，"
        + ("已连接" if result["connected"] else f"失败原因 {result['reason']}")
        for provider, result in endpoint_results.items()
    )

    raise TransientProviderError(
        f"Google 代理链路不稳定：{summary}。"
        "本地请求已交给代理，但上游 TLS 隧道未稳定建立；请检查 *.googleapis.com 的代理规则和出口节点后重试。",
        provider="google",
        stage="connection_preflight",
        code="provider_connection_failed",
    )


def _probe_endpoint(request: Request, timeout_s: float) -> None:
    try:
        with urlopen(request, timeout=timeout_s):  # noqa: S310 - fixed Google HTTPS endpoints
            return
    except HTTPError as exc:
        # HEAD requests are intentionally unauthenticated, so 4xx/405 is a
        # valid reachability signal. A 407 means the proxy path itself is not
        # usable and must be reported before real provider work begins.
        if exc.code == 407:
            raise URLError("proxy authentication required") from exc
        return


def _safe_network_reason(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None)
    value = reason if reason is not None else exc
    text = " ".join(str(value or type(exc).__name__).split())
    return (text or type(exc).__name__)[:200]
