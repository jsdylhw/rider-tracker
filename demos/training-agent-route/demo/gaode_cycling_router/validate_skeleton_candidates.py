#!/usr/bin/env python3
"""Provider-validate a small set of landmark route-book order candidates.

This script is stage four of the evidence workflow.  It never discovers
segments and it never relabels a partially evidenced route as a verified
landmark loop.  Its output is browser-ready GCJ-02 GeoJSON: opening the AMap
Demo with ``?probe=<output-stem>`` shows the actual bicycle-navigation
candidates immediately.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from demo.osm_cycling_router.router import Point
from demo.osm_cycling_router.segment_loop import segment_from_feature

from .amap import AmapCyclingRouter
from .planner import candidate_preview_feature, plan_ordered_wgs84_segments_with_amap
from .route_workflow import rank_skeleton_orders
from .web_server import load_amap_settings


def _point(value: str) -> Point:
    try:
        lat, lon = (float(part.strip()) for part in value.split(",", 1))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--start must be latitude,longitude in WGS-84") from exc
    return Point(lat, lon)


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate top landmark route-book orders with AMap bicycling")
    parser.add_argument("--input", type=Path, required=True, help="WGS-84 Strava detail FeatureCollection")
    parser.add_argument("--segment-id", type=int, action="append", required=True, help="include this detail Segment id; repeatable")
    parser.add_argument("--start", type=_point, required=True)
    parser.add_argument("--min-km", type=float, required=True)
    parser.add_argument("--max-km", type=float, required=True)
    parser.add_argument("--max-candidates", type=int, default=3)
    parser.add_argument("--start-name", default="指定起点")
    parser.add_argument("--name", default="路段骨架候选（高德骑行）")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.min_km <= 0 or args.max_km < args.min_km:
        parser.error("distance range must be positive and ordered")
    source = json.loads(args.input.read_text(encoding="utf-8"))
    # Accept either the persisted evidence run or its extracted GeoJSON, so a
    # user does not need an unsafe/manual conversion between workflow stages.
    collection = source.get("detail_feature_collection") if isinstance(source.get("detail_feature_collection"), dict) else source
    wanted = set(args.segment_id)
    available = {
        int(feature.get("properties", {}).get("id")): segment_from_feature(feature)
        for feature in collection.get("features") or []
        if feature.get("properties", {}).get("kind") == "strava_segment"
        and feature.get("properties", {}).get("id") is not None
    }
    missing = sorted(wanted - set(available))
    if missing:
        parser.error(f"requested segment id(s) are missing: {missing}")
    ordered = [available[segment_id] for segment_id in args.segment_id]
    ranked = rank_skeleton_orders(
        ordered, start=args.start, target_distance_m=(args.min_km + args.max_km) * 500,
        max_candidates=args.max_candidates,
    )
    settings = load_amap_settings(Path(__file__).resolve().parent)
    try:
        router = AmapCyclingRouter(settings["web_service_key"])
    except ValueError as exc:
        parser.error(str(exc))
    features = []
    failures = []
    for index, order in enumerate(ranked, start=1):
        try:
            route = plan_ordered_wgs84_segments_with_amap(
                order.segments, start=args.start, target_distance_m=(args.min_km + args.max_km) * 500,
                router=router, start_name=args.start_name,
            )
            features.append(candidate_preview_feature(
                route, index=index, name=args.name,
                min_distance_m=args.min_km * 1_000, max_distance_m=args.max_km * 1_000,
            ))
        except Exception as exc:  # noqa: BLE001 - preserve other candidates
            failures.append({"candidate_index": index, "order": order.as_dict(), "error": type(exc).__name__, "message": str(exc)})
    output = {
        "type": "FeatureCollection",
        "metadata": {
            "name": args.name,
            "coordinate_system": "gcj02",
            "source_coordinate_system": "wgs84",
            "provider": "amap",
            "mode": "bicycling",
            "requested_distance_range_m": [args.min_km * 1_000, args.max_km * 1_000],
            "candidate_count": len(features),
            "ranked_orders": [item.as_dict() for item in ranked],
            "failures": failures,
            "landmark_evidence_note": "Provider-routed preview only. Keep the evidence-run status separate before calling this a verified landmark loop.",
        },
        "features": features,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"candidate_count": len(features), "failures": failures, "output": str(args.output)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
