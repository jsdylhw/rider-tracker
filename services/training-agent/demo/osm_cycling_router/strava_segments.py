"""Compatibility imports and CLI entrypoint for the Strava Segment demo."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from integrations.route_providers.strava_segments import (
    COMPATIBLE_API_BASE_URL,
    DEFAULT_API_BASE_URL,
    StravaSegmentNetworkError,
    decode_polyline,
    explore_segments,
    fetch_segment_detail,
    segment_detail_feature,
    segment_details_feature_collection,
)

__all__ = [
    "COMPATIBLE_API_BASE_URL",
    "DEFAULT_API_BASE_URL",
    "StravaSegmentNetworkError",
    "decode_polyline",
    "explore_segments",
    "fetch_segment_detail",
    "segment_detail_feature",
    "segment_details_feature_collection",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--bounds", help="south,west,north,east in WGS-84")
    source.add_argument("--segment-id", type=int, action="append", help="fetch this Segment detail, repeatable")
    parser.add_argument("--output", type=Path, default=Path("data/strava-segment-sample.json"))
    parser.add_argument("--token-env", default="STRAVA_ACCESS_TOKEN")
    parser.add_argument("--base-url", default=DEFAULT_API_BASE_URL)
    args = parser.parse_args()
    token = os.environ.get(args.token_env, "").strip()
    if not token:
        parser.error(f"environment variable {args.token_env} is required")
    if args.bounds:
        sample = explore_segments(args.bounds, token, base_url=args.base_url)
    else:
        details = [fetch_segment_detail(item, token, base_url=args.base_url) for item in args.segment_id or ()]
        sample = segment_details_feature_collection(details)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(sample, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    count = sample.get("segment_count", len(sample.get("features") or []))
    print(f"Saved {count} segments to {args.output}")


if __name__ == "__main__":
    main()
