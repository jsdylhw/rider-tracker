#!/usr/bin/env python3
"""Route between a FIT activity's endpoints using the local GraphHopper demo."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from router import Point, endpoints_from_fit, route


def _point(value: str) -> Point:
    try:
        lat, lon = (float(part.strip()) for part in value.split(",", 1))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("point must be 'lat,lon'") from exc
    return Point(lat=lat, lon=lon)


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--fit", type=Path, help="FIT file; its first/last GPS points are used")
    source.add_argument("--origin", type=_point, help="origin as lat,lon; requires --destination")
    parser.add_argument("--destination", type=_point, help="destination as lat,lon")
    parser.add_argument("--profile", choices=("bike", "racingbike"), default="bike")
    parser.add_argument("--router-url", default="http://127.0.0.1:8989")
    args = parser.parse_args()

    if args.fit:
        origin, destination = endpoints_from_fit(args.fit)
    else:
        if args.destination is None:
            parser.error("--destination is required when --origin is used")
        origin, destination = args.origin, args.destination

    result = route(origin, destination, profile=args.profile, base_url=args.router_url)
    print(json.dumps({
        "origin": origin.__dict__,
        "destination": destination.__dict__,
        **{key: value for key, value in result.items() if key != "raw"},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
