#!/usr/bin/env python3
"""Local OSM place search for the cycling-router demo.

The index deliberately contains only route-planning landmarks: lakes and
reservoirs, viewpoints, parks/nature, attractions, historic destinations, and
settlements useful as navigation anchors. It does not index generic shops or
restaurants, so an LLM cannot be flooded with irrelevant POIs.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCENIC_CATEGORIES = frozenset({
    "lake", "reservoir", "waterfall", "peak", "viewpoint", "park",
    "nature", "attraction", "historic", "settlement",
})
EARTH_RADIUS_M = 6_371_000.0


@dataclass(frozen=True)
class Place:
    osm_type: str
    osm_id: int
    name: str
    category: str
    lat: float
    lon: float
    tags: dict[str, str]
    distance_m: float | None = None

    def as_dict(self) -> dict[str, Any]:
        result = {
            "osm_type": self.osm_type,
            "osm_id": self.osm_id,
            "name": self.name,
            "category": self.category,
            "lat": self.lat,
            "lon": self.lon,
            "tags": self.tags,
        }
        if self.distance_m is not None:
            result["distance_m"] = round(self.distance_m, 1)
        return result


def scenic_category(tags: dict[str, str]) -> str | None:
    """Return a bounded route-planning category for useful OSM objects."""
    natural = tags.get("natural")
    water = tags.get("water")
    tourism = tags.get("tourism")
    leisure = tags.get("leisure")
    place = tags.get("place")
    historic = tags.get("historic")

    if natural == "water" or water in {"lake", "pond"}:
        return "lake"
    if water == "reservoir" or tags.get("landuse") == "reservoir":
        return "reservoir"
    if natural == "waterfall":
        return "waterfall"
    if natural in {"peak", "volcano"}:
        return "peak"
    if tourism == "viewpoint":
        return "viewpoint"
    if leisure in {"park", "nature_reserve"}:
        return "park" if leisure == "park" else "nature"
    if tags.get("boundary") == "national_park":
        return "nature"
    if tourism in {"attraction", "museum", "zoo", "theme_park"}:
        return "attraction"
    if historic in {"castle", "monument", "memorial", "ruins", "archaeological_site"}:
        return "historic"
    if place in {"city", "town", "village", "suburb", "hamlet"}:
        return "settlement"
    return None


def display_name(tags: dict[str, str]) -> str | None:
    return tags.get("name:zh") or tags.get("name") or tags.get("name:en")


def _connect(path: str | Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript("""
        DROP TABLE IF EXISTS place_rtree;
        DROP TABLE IF EXISTS places;
        CREATE TABLE places (
            id INTEGER PRIMARY KEY,
            osm_type TEXT NOT NULL,
            osm_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            category TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            tags_json TEXT NOT NULL,
            UNIQUE(osm_type, osm_id)
        );
        CREATE VIRTUAL TABLE place_rtree USING rtree(
            id, min_lat, max_lat, min_lon, max_lon
        );
        CREATE INDEX places_name_idx ON places(normalized_name);
        CREATE INDEX places_category_idx ON places(category);
    """)


def normalize_name(value: str) -> str:
    return "".join(value.casefold().split())


def haversine_m(first_lat: float, first_lon: float, second_lat: float, second_lon: float) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (first_lat, first_lon, second_lat, second_lon))
    value = math.sin((lat2 - lat1) / 2) ** 2
    value += math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.asin(math.sqrt(value))


def insert_place(connection: sqlite3.Connection, place: Place) -> None:
    existing = connection.execute(
        "SELECT id FROM places WHERE osm_type = ? AND osm_id = ?",
        (place.osm_type, place.osm_id),
    ).fetchone()
    if existing:
        connection.execute("DELETE FROM place_rtree WHERE id = ?", (existing["id"],))
    connection.execute(
        """INSERT INTO places
           (osm_type, osm_id, name, normalized_name, category, lat, lon, tags_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(osm_type, osm_id) DO UPDATE SET
             name=excluded.name,
             normalized_name=excluded.normalized_name,
             category=excluded.category,
             lat=excluded.lat,
             lon=excluded.lon,
             tags_json=excluded.tags_json""",
        (
            place.osm_type, place.osm_id, place.name, normalize_name(place.name),
            place.category, place.lat, place.lon,
            json.dumps(place.tags, ensure_ascii=False, sort_keys=True),
        ),
    )
    row = connection.execute(
        "SELECT id FROM places WHERE osm_type = ? AND osm_id = ?",
        (place.osm_type, place.osm_id),
    ).fetchone()
    connection.execute("DELETE FROM place_rtree WHERE id = ?", (row["id"],))
    connection.execute(
        "INSERT INTO place_rtree VALUES (?, ?, ?, ?, ?)",
        (row["id"], place.lat, place.lat, place.lon, place.lon),
    )


def _row_to_place(row: sqlite3.Row, *, distance_m: float | None = None) -> Place:
    return Place(
        osm_type=str(row["osm_type"]),
        osm_id=int(row["osm_id"]),
        name=str(row["name"]),
        category=str(row["category"]),
        lat=float(row["lat"]),
        lon=float(row["lon"]),
        tags=json.loads(str(row["tags_json"])),
        distance_m=distance_m,
    )


def search_places(
    database: str | Path,
    query: str,
    *,
    near: tuple[float, float] | None = None,
    categories: Sequence[str] | None = None,
    limit: int = 8,
) -> list[Place]:
    normalized = normalize_name(query)
    if not normalized:
        raise ValueError("query must not be empty")
    categories = tuple(categories or SCENIC_CATEGORIES)
    invalid = set(categories) - SCENIC_CATEGORIES
    if invalid:
        raise ValueError(f"unsupported categories: {sorted(invalid)}")
    placeholders = ",".join("?" for _ in categories)
    connection = _connect(database)
    try:
        rows = connection.execute(
            f"""SELECT * FROM places
                WHERE category IN ({placeholders})
                  AND normalized_name LIKE ?""",
            (*categories, f"%{normalized}%"),
        ).fetchall()
    finally:
        connection.close()

    places = []
    for row in rows:
        distance = haversine_m(near[0], near[1], row["lat"], row["lon"]) if near else None
        places.append(_row_to_place(row, distance_m=distance))

    def rank(place: Place) -> tuple[int, float, str]:
        exact_rank = 0 if normalize_name(place.name) == normalized else 1
        distance = place.distance_m if place.distance_m is not None else float("inf")
        return exact_rank, distance, place.name

    return sorted(places, key=rank)[:limit]


def nearby_scenic_places(
    database: str | Path,
    *,
    lat: float,
    lon: float,
    radius_m: float = 2_000.0,
    categories: Sequence[str] | None = None,
    limit: int = 20,
) -> list[Place]:
    if radius_m <= 0 or radius_m > 50_000:
        raise ValueError("radius_m must be between 1 and 50000")
    categories = tuple(categories or ("lake", "reservoir", "waterfall", "peak", "viewpoint", "park", "nature", "attraction", "historic"))
    invalid = set(categories) - SCENIC_CATEGORIES
    if invalid:
        raise ValueError(f"unsupported categories: {sorted(invalid)}")
    lat_delta = radius_m / 111_320.0
    lon_delta = radius_m / (111_320.0 * max(math.cos(math.radians(lat)), 0.01))
    placeholders = ",".join("?" for _ in categories)
    connection = _connect(database)
    try:
        rows = connection.execute(
            f"""SELECT p.* FROM places p
                JOIN place_rtree r ON r.id = p.id
                WHERE p.category IN ({placeholders})
                  AND r.min_lat >= ? AND r.max_lat <= ?
                  AND r.min_lon >= ? AND r.max_lon <= ?""",
            (*categories, lat - lat_delta, lat + lat_delta, lon - lon_delta, lon + lon_delta),
        ).fetchall()
    finally:
        connection.close()
    places = [
        _row_to_place(row, distance_m=haversine_m(lat, lon, row["lat"], row["lon"]))
        for row in rows
    ]
    return sorted((item for item in places if item.distance_m is not None and item.distance_m <= radius_m), key=lambda item: item.distance_m)[:limit]


class ScenicPlaceHandler:  # constructed lazily so normal queries do not require pyosmium
    def __new__(cls, connection: sqlite3.Connection):
        try:
            import osmium
        except ImportError as exc:  # pragma: no cover - environment-level error
            raise RuntimeError("Install pyosmium first: python -m pip install osmium") from exc

        class Handler(osmium.SimpleHandler):
            def __init__(self) -> None:
                super().__init__()
                self.connection = connection
                self.count = 0

            def node(self, node: Any) -> None:
                if not node.location.valid():
                    return
                self._record("node", node.id, dict(node.tags), node.location.lat, node.location.lon)

            def way(self, way: Any) -> None:
                points = [(item.location.lat, item.location.lon) for item in way.nodes if item.location.valid()]
                if not points:
                    return
                self._record(
                    "way", way.id, dict(way.tags),
                    sum(point[0] for point in points) / len(points),
                    sum(point[1] for point in points) / len(points),
                )

            def _record(self, osm_type: str, osm_id: int, tags: dict[str, str], lat: float, lon: float) -> None:
                category = scenic_category(tags)
                name = display_name(tags)
                if category is None or name is None:
                    return
                insert_place(self.connection, Place(osm_type, osm_id, name, category, lat, lon, tags))
                self.count += 1
                if self.count % 500 == 0:
                    self.connection.commit()

        return Handler()


def build_index(pbf: str | Path, database: str | Path) -> int:
    try:
        import osmium
    except ImportError as exc:  # pragma: no cover - environment-level error
        raise RuntimeError("Install pyosmium first: python -m pip install osmium") from exc
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    connection = _connect(database)
    try:
        create_schema(connection)
        handler = ScenicPlaceHandler(connection)
        # Limit the reader to nodes and ways.  Reading relations is unnecessary
        # for this compact landmark index and triggers needless work for a
        # province-scale PBF. sparse_mem_array keeps the node-location lookup
        # practical while calculating representative positions for named ways
        # such as lakes, reservoirs, parks, and scenic roads.
        locations = osmium.NodeLocationsForWays(osmium.index.create_map("sparse_mem_array"))
        with osmium.io.Reader(str(pbf), osmium.osm.NODE | osmium.osm.WAY) as reader:
            osmium.apply(reader, locations, handler)
        connection.commit()
        return handler.count
    finally:
        connection.close()


def _point(value: str) -> tuple[float, float]:
    try:
        lat, lon = (float(part.strip()) for part in value.split(",", 1))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("point must be 'lat,lon'") from exc
    return lat, lon


def main() -> None:
    parser = argparse.ArgumentParser(description="Search local scenic OSM places")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build")
    build.add_argument("--pbf", type=Path, required=True)
    build.add_argument("--database", type=Path, required=True)

    search = subparsers.add_parser("search")
    search.add_argument("query")
    search.add_argument("--database", type=Path, required=True)
    search.add_argument("--near", type=_point)
    search.add_argument("--category", action="append", choices=sorted(SCENIC_CATEGORIES))
    search.add_argument("--limit", type=int, default=8)

    nearby = subparsers.add_parser("nearby")
    nearby.add_argument("--point", type=_point, required=True)
    nearby.add_argument("--database", type=Path, required=True)
    nearby.add_argument("--radius-m", type=float, default=2_000.0)
    nearby.add_argument("--category", action="append", choices=sorted(SCENIC_CATEGORIES))
    nearby.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    if args.command == "build":
        print(json.dumps({"indexed": build_index(args.pbf, args.database)}, ensure_ascii=False))
    elif args.command == "search":
        print(json.dumps([item.as_dict() for item in search_places(args.database, args.query, near=args.near, categories=args.category, limit=args.limit)], ensure_ascii=False, indent=2))
    else:
        lat, lon = args.point
        print(json.dumps([item.as_dict() for item in nearby_scenic_places(args.database, lat=lat, lon=lon, radius_m=args.radius_m, categories=args.category, limit=args.limit)], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
