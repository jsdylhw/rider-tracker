#!/usr/bin/env python3
"""Probe Google Places through the proxy node currently selected in Clash Verge.

Run from the repository root, switch the selected Clash node between runs,
and compare success rate plus latency. Each attempt makes one Places API call.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import getproxies


ROOT = Path(__file__).resolve().parent
TRAINING_AGENT = ROOT / "services" / "training-agent"
sys.path.insert(0, str(TRAINING_AGENT))

from integrations.google_places import GooglePlacesClient  # noqa: E402
from integrations.provider_error import ProviderError  # noqa: E402
from settings import load_config  # noqa: E402


def _active_https_proxy() -> str:
    proxy = getproxies().get("https") or getproxies().get("http")
    if not proxy:
        return "not detected (system/TUN routing may still apply)"
    parsed = urlsplit(proxy if "://" in proxy else f"http://{proxy}")
    if not parsed.hostname:
        return "configured (address unavailable)"
    address = parsed.hostname
    if ":" in address and not address.startswith("["):
        address = f"[{address}]"
    return f"{parsed.scheme or 'http'}://{address}:{parsed.port}" if parsed.port else f"{parsed.scheme or 'http'}://{address}"


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def _error_label(error: Exception) -> str:
    if isinstance(error, ProviderError):
        message = str(error)
        # These adapter messages are normalized and never include the API key.
        if message.startswith("Google Places HTTP "):
            return message
        if "TLS 连接被提前关闭" in message:
            return "TLS EOF (connection closed early)"
        if "TLS 证书验证失败" in message:
            return "TLS certificate verification failed"
        if "timed out" in message.lower() or "timeout" in message.lower():
            return "network timeout"
        return f"{error.code}/{error.stage}"
    return type(error).__name__


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Test the currently selected Clash Verge node against Google Places."
    )
    parser.add_argument("--count", type=int, default=5, help="number of API requests (default: 5)")
    parser.add_argument("--interval", type=float, default=1.0, help="seconds between requests (default: 1)")
    parser.add_argument("--timeout", type=float, default=8.0, help="per-request timeout in seconds (default: 8)")
    parser.add_argument("--query", default="Tokyo Station", help="same query should be used for every node")
    parser.add_argument("--language", default="en", help="Places language code (default: en)")
    args = parser.parse_args()

    if args.count < 1 or args.interval < 0 or args.timeout <= 0:
        parser.error("count must be >= 1, interval >= 0, and timeout > 0")

    config = load_config()
    google = config.get("google") if isinstance(config.get("google"), dict) else {}
    api_key = os.environ.get("GOOGLE_MAPS_API_KEY") or google.get("api_key") or ""
    if not str(api_key).strip() or str(api_key).startswith("replace-with-"):
        print("Google Places API key is not configured (config value was not displayed).", file=sys.stderr)
        return 2

    client = GooglePlacesClient(
        str(api_key), timeout_seconds=args.timeout, retries=0,
    )
    print("Google Places node test")
    print(f"HTTPS proxy: {_active_https_proxy()}")
    print(f"Query: {args.query!r} | attempts: {args.count} | retries per attempt: 0")
    print("Each attempt makes one Places API request and uses API quota/billing.\n")

    latencies: list[float] = []
    successes = 0
    for attempt in range(1, args.count + 1):
        started = time.monotonic()
        try:
            result = client.search(args.query, language_code=args.language, limit=1)
            elapsed = time.monotonic() - started
            latencies.append(elapsed)
            successes += 1
            print(f"{attempt:02}/{args.count:02}  OK    {elapsed:.2f}s  places={len(result['places'])}", flush=True)
        except Exception as error:  # Report individual failures and continue sampling.
            elapsed = time.monotonic() - started
            print(f"{attempt:02}/{args.count:02}  FAIL  {elapsed:.2f}s  {_error_label(error)}", flush=True)
        if attempt < args.count and args.interval:
            time.sleep(args.interval)

    failure_count = args.count - successes
    success_rate = successes / args.count * 100
    median = _percentile(latencies, 0.50)
    p95 = _percentile(latencies, 0.95)
    print("\nSummary")
    print(f"Success: {successes}/{args.count} ({success_rate:.0f}%)")
    if median is not None:
        print(f"Successful request latency: median={median:.2f}s, p95={p95:.2f}s")
    else:
        print("Successful request latency: no successful samples")
    print("Compare this result with the same query and settings after selecting another Clash node.")
    return 1 if failure_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
