#!/usr/bin/env python3
"""Compose an approved WGS-84 Strava skeleton with AMap bicycling connectors."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from demo.osm_cycling_router.router import Point
from demo.osm_cycling_router.segment_loop import candidate_geojson, segment_from_feature

from .amap import AmapCyclingRouter
from .planner import plan_ordered_wgs84_segments_with_amap
from .web_server import load_amap_settings


def parse_wgs84_point(value: str) -> Point:
    try:
        lat, lon = (float(part.strip()) for part in value.split(",", 1))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("point must be latitude,longitude in WGS-84") from exc
    return Point(lat, lon)


def main() -> None:
    demo_dir = Path(__file__).resolve().parent
    settings = load_amap_settings(demo_dir)
    parser = argparse.ArgumentParser(description="Use AMap bicycling to compose a fixed Strava/OSM route skeleton")
    parser.add_argument("--input", type=Path, required=True, help="WGS-84 FeatureCollection containing strava_segment features")
    parser.add_argument("--segment-id", type=int, action="append", required=True, help="segment id in intended travel order; repeat this argument")
    parser.add_argument("--start", type=parse_wgs84_point, required=True, help="WGS-84 start: latitude,longitude")
    parser.add_argument("--target-km", type=float, required=True)
    parser.add_argument("--near-handoff-m", type=float, default=0, help="preserve a short observed skeleton seam for review")
    parser.add_argument("--start-name", default="指定起终点")
    parser.add_argument("--name", default="高德骑行骨架闭环（实验）")
    parser.add_argument("--output", type=Path, required=True, help="GCJ-02 GeoJSON that can be displayed on the AMap demo")
    args = parser.parse_args()
    if args.target_km <= 0:
        parser.error("--target-km must be positive")
    source = json.loads(args.input.read_text(encoding="utf-8"))
    features = {
        int(feature.get("properties", {}).get("id")): feature
        for feature in source.get("features") or []
        if feature.get("properties", {}).get("kind") == "strava_segment" and feature.get("properties", {}).get("id") is not None
    }
    missing = [identifier for identifier in args.segment_id if identifier not in features]
    if missing:
        parser.error(f"requested segment id(s) are missing: {missing}")
    try:
        router = AmapCyclingRouter(settings["web_service_key"])
    except ValueError as exc:
        parser.error(str(exc) + "; copy .env.example to .env and fill it first")
    candidate = plan_ordered_wgs84_segments_with_amap(
        [segment_from_feature(features[identifier]) for identifier in args.segment_id],
        start=args.start,
        target_distance_m=args.target_km * 1_000,
        router=router,
        start_name=args.start_name,
        near_handoff_m=args.near_handoff_m,
    )
    output = candidate_geojson(candidate, name=args.name, target_distance_m=args.target_km * 1_000)
    output["metadata"].update({
        "connector_provider": "amap", "connector_mode": "bicycling",
        "coordinate_system": "gcj02", "source_coordinate_system": "wgs84",
    })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(output["metadata"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
