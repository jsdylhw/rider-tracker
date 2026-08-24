#!/usr/bin/env python3
"""Run and persist one bounded landmark-route evidence discovery pass."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .route_evidence import Bounds
from .route_workflow import LandmarkRouteRequest, run_landmark_evidence_workflow


def main() -> None:
    parser = argparse.ArgumentParser(description="Discover verifiable Strava evidence before planning a named cycling loop")
    parser.add_argument("--name", required=True, help="landmark name, e.g. 淀山湖")
    parser.add_argument("--bounds", required=True, help="WGS-84 south,west,north,east")
    parser.add_argument("--min-km", type=float, required=True)
    parser.add_argument("--max-km", type=float, required=True)
    parser.add_argument("--start-name", default="指定起点")
    parser.add_argument("--alias", action="append", default=[], help="optional landmark alias used only to rank detail fetches; repeatable")
    parser.add_argument("--rows", type=int, default=2)
    parser.add_argument("--columns", type=int, default=2)
    parser.add_argument("--max-detail-segments", type=int, default=12)
    parser.add_argument("--request-budget-s", type=float, default=45.0)
    parser.add_argument("--token-env", default="STRAVA_ACCESS_TOKEN")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    token = os.getenv(args.token_env, "").strip()
    if not token:
        parser.error(f"environment variable {args.token_env} is required")
    try:
        south, west, north, east = (float(value.strip()) for value in args.bounds.split(","))
    except ValueError as exc:
        parser.error("--bounds must be south,west,north,east in WGS-84")
        raise AssertionError from exc  # pragma: no cover - argparse exits
    request = LandmarkRouteRequest(
        landmark=args.name, target_bounds=Bounds(south, west, north, east),
        min_distance_m=args.min_km * 1_000, max_distance_m=args.max_km * 1_000,
        start_name=args.start_name, landmark_aliases=tuple(args.alias),
    )
    result = run_landmark_evidence_workflow(
        request, token, rows=args.rows, columns=args.columns, max_detail_segments=args.max_detail_segments,
        request_budget_s=args.request_budget_s,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": result["status"], "selected_segment_ids": result["selected_segment_ids"],
        "detail_failures": len(result["detail_failures"]), "next_action": result["next_action"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
