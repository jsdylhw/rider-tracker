#!/usr/bin/env python3
"""Build and query a compact semantic-road index for route experiments.

GraphHopper already owns the full routing graph.  This module deliberately
does not duplicate it: it keeps only roads that carry a useful human-facing
signal (name, ref, route relation, or bicycle tag), plus a simplified geometry
and an R-Tree.  The planner can therefore turn a request such as ``YBA4`` or
``春风十里路`` into factual corridor anchors before asking GraphHopper to route.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import struct
import zlib
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


EARTH_RADIUS_M = 6_371_000.0
GEOMETRY_SCALE = 1_000_000
SIMPLIFY_TOLERANCE_M = 15.0
MAX_QUERY_ROWS = 2_000
ROUTABLE_HIGHWAYS = frozenset({
    "trunk", "trunk_link", "primary", "primary_link", "secondary",
    "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "service", "living_street", "track", "cycleway", "path",
})


@dataclass(frozen=True)
class RouteRelation:
    osm_relation_id: int
    name: str | None
    ref: str | None
    members: tuple[int, ...]


@dataclass(frozen=True)
class RoadCorridor:
    """A searchable logical corridor assembled from one or more OSM ways."""

    name: str | None
    ref: str | None
    highway_classes: tuple[str, ...]
    osm_way_ids: tuple[int, ...]
    relation_ids: tuple[int, ...]
    anchors: tuple[tuple[float, float], ...]
    distance_m: float | None = None

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "name": self.name,
            "ref": self.ref,
            "highway_classes": list(self.highway_classes),
            "segment_count": len(self.osm_way_ids),
            "osm_way_ids": list(self.osm_way_ids),
            "relation_ids": list(self.relation_ids),
            "anchors": [{"lat": lat, "lon": lon} for lat, lon in self.anchors],
        }
        if self.distance_m is not None:
            result["distance_m"] = round(self.distance_m, 1)
        return result


def normalize(value: str | None) -> str:
    return "".join((value or "").casefold().split())


def _display_name(tags: dict[str, str]) -> str | None:
    return tags.get("name:zh") or tags.get("name") or tags.get("name:en")


def _aliases(tags: dict[str, str]) -> tuple[str, ...]:
    values = (
        tags.get("name:zh"), tags.get("name"), tags.get("name:en"),
        tags.get("alt_name"), tags.get("official_name"),
    )
    return tuple(dict.fromkeys(value for value in values if value))


def _is_semantic_road(tags: dict[str, str], *, in_named_route: bool) -> bool:
    road_class = tags.get("highway")
    if road_class not in ROUTABLE_HIGHWAYS:
        return False
    return bool(
        in_named_route
        or _aliases(tags)
        or tags.get("ref")
        or tags.get("bicycle")
        or tags.get("cycleway")
        or tags.get("cycleway:left")
        or tags.get("cycleway:right")
        or road_class == "cycleway"
    )


def _meters(point: tuple[float, float], reference_lat: float) -> tuple[float, float]:
    lat, lon = point
    return lon * 111_320.0 * math.cos(math.radians(reference_lat)), lat * 111_320.0


def _distance_to_line_m(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    reference_lat = (start[0] + end[0]) / 2
    px, py = _meters(point, reference_lat)
    ax, ay = _meters(start, reference_lat)
    bx, by = _meters(end, reference_lat)
    dx, dy = bx - ax, by - ay
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return math.hypot(px - ax, py - ay)
    ratio = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_squared))
    return math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy))


def simplify_geometry(points: Sequence[tuple[float, float]], *, tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> tuple[tuple[float, float], ...]:
    """Keep line endpoints and bends that matter at cycling-route scale."""
    if len(points) <= 2:
        return tuple(points)
    keep = {0, len(points) - 1}
    pending = [(0, len(points) - 1)]
    while pending:
        first, last = pending.pop()
        if last - first <= 1:
            continue
        max_index, max_distance = first, -1.0
        for index in range(first + 1, last):
            distance = _distance_to_line_m(points[index], points[first], points[last])
            if distance > max_distance:
                max_index, max_distance = index, distance
        if max_distance > tolerance_m:
            keep.add(max_index)
            pending.append((first, max_index))
            pending.append((max_index, last))
    return tuple(points[index] for index in sorted(keep))


def encode_geometry(points: Sequence[tuple[float, float]]) -> bytes:
    """Store latitude/longitude pairs compactly without a geometry dependency."""
    payload = bytearray(struct.pack("<I", len(points)))
    for lat, lon in points:
        payload.extend(struct.pack("<ii", round(lat * GEOMETRY_SCALE), round(lon * GEOMETRY_SCALE)))
    return zlib.compress(bytes(payload), level=6)


def decode_geometry(payload: bytes) -> tuple[tuple[float, float], ...]:
    raw = zlib.decompress(payload)
    count = struct.unpack_from("<I", raw)[0]
    expected_length = 4 + count * 8
    if len(raw) != expected_length:
        raise ValueError("invalid road geometry payload")
    return tuple(
        (lat / GEOMETRY_SCALE, lon / GEOMETRY_SCALE)
        for lat, lon in (struct.unpack_from("<ii", raw, 4 + index * 8) for index in range(count))
    )


def haversine_m(first: tuple[float, float], second: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*first, *second))
    value = math.sin((lat2 - lat1) / 2) ** 2
    value += math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.asin(math.sqrt(value))


def distance_to_geometry_m(point: tuple[float, float], geometry: Sequence[tuple[float, float]]) -> float:
    if len(geometry) == 1:
        return haversine_m(point, geometry[0])
    return min(_distance_to_line_m(point, start, end) for start, end in zip(geometry, geometry[1:]))


def _connect(database: str | Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    return connection


def create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript("""
        DROP TABLE IF EXISTS road_segment_rtree;
        DROP TABLE IF EXISTS road_relation_members;
        DROP TABLE IF EXISTS road_relations;
        DROP TABLE IF EXISTS road_segments;

        CREATE TABLE road_segments (
            id INTEGER PRIMARY KEY,
            osm_way_id INTEGER NOT NULL UNIQUE,
            highway TEXT NOT NULL,
            name TEXT,
            normalized_name TEXT,
            ref TEXT,
            normalized_ref TEXT,
            aliases_json TEXT NOT NULL,
            surface TEXT,
            bicycle TEXT,
            cycleway TEXT,
            geometry BLOB NOT NULL,
            geometry_point_count INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE road_segment_rtree USING rtree(
            id, min_lat, max_lat, min_lon, max_lon
        );
        CREATE TABLE road_relations (
            osm_relation_id INTEGER PRIMARY KEY,
            name TEXT,
            normalized_name TEXT,
            ref TEXT,
            normalized_ref TEXT
        );
        CREATE TABLE road_relation_members (
            osm_relation_id INTEGER NOT NULL,
            osm_way_id INTEGER NOT NULL,
            PRIMARY KEY(osm_relation_id, osm_way_id)
        );
        CREATE INDEX road_segments_name_idx ON road_segments(normalized_name);
        CREATE INDEX road_segments_ref_idx ON road_segments(normalized_ref);
        CREATE INDEX road_relations_name_idx ON road_relations(normalized_name);
        CREATE INDEX road_relations_ref_idx ON road_relations(normalized_ref);
        CREATE INDEX road_relation_members_way_idx ON road_relation_members(osm_way_id);
    """)


def _insert_relation(connection: sqlite3.Connection, relation: RouteRelation) -> None:
    connection.execute(
        """INSERT INTO road_relations (osm_relation_id, name, normalized_name, ref, normalized_ref)
           VALUES (?, ?, ?, ?, ?)""",
        (relation.osm_relation_id, relation.name, normalize(relation.name), relation.ref, normalize(relation.ref)),
    )
    connection.executemany(
        "INSERT INTO road_relation_members (osm_relation_id, osm_way_id) VALUES (?, ?)",
        ((relation.osm_relation_id, member) for member in relation.members),
    )


def _insert_segment(
    connection: sqlite3.Connection,
    *,
    osm_way_id: int,
    tags: dict[str, str],
    geometry: Sequence[tuple[float, float]],
) -> None:
    simplified = simplify_geometry(geometry)
    lats, lons = zip(*simplified)
    name = _display_name(tags)
    ref = tags.get("ref")
    cursor = connection.execute(
        """INSERT INTO road_segments
           (osm_way_id, highway, name, normalized_name, ref, normalized_ref, aliases_json,
            surface, bicycle, cycleway, geometry, geometry_point_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            osm_way_id, tags["highway"], name, normalize(name), ref, normalize(ref),
            json.dumps(_aliases(tags), ensure_ascii=False), tags.get("surface"), tags.get("bicycle"),
            tags.get("cycleway") or tags.get("cycleway:left") or tags.get("cycleway:right"),
            encode_geometry(simplified), len(simplified),
        ),
    )
    connection.execute(
        "INSERT INTO road_segment_rtree VALUES (?, ?, ?, ?, ?)",
        (cursor.lastrowid, min(lats), max(lats), min(lons), max(lons)),
    )


def collect_named_road_relations(pbf: str | Path) -> tuple[RouteRelation, ...]:
    """Collect named/ref'ed ``route=road`` relations before reading way geometry."""
    try:
        import osmium
    except ImportError as exc:  # pragma: no cover - environment-level error
        raise RuntimeError("Install pyosmium first: python -m pip install osmium") from exc

    class Handler(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.relations: list[RouteRelation] = []

        def relation(self, relation: Any) -> None:
            tags = dict(relation.tags)
            if tags.get("route") != "road":
                return
            name = _display_name(tags)
            ref = tags.get("ref")
            if not name and not ref:
                return
            # A route relation can list the same way more than once (for
            # example with separate forward/backward roles). Membership here
            # is semantic, not directional, so keep one stable reference.
            members = tuple(dict.fromkeys(member.ref for member in relation.members if member.type == "w"))
            if members:
                self.relations.append(RouteRelation(relation.id, name, ref, members))

    handler = Handler()
    with osmium.io.Reader(str(pbf), osmium.osm.RELATION) as reader:
        osmium.apply(reader, handler)
    return tuple(handler.relations)


class SemanticRoadHandler:
    """Lazily construct a pyosmium handler so read-only queries need no pyosmium."""

    def __new__(cls, connection: sqlite3.Connection, route_member_ids: set[int]):
        try:
            import osmium
        except ImportError as exc:  # pragma: no cover - environment-level error
            raise RuntimeError("Install pyosmium first: python -m pip install osmium") from exc

        class Handler(osmium.SimpleHandler):
            def __init__(self) -> None:
                super().__init__()
                self.connection = connection
                self.route_member_ids = route_member_ids
                self.count = 0

            def way(self, way: Any) -> None:
                tags = dict(way.tags)
                if not _is_semantic_road(tags, in_named_route=way.id in self.route_member_ids):
                    return
                geometry = tuple((node.location.lat, node.location.lon) for node in way.nodes if node.location.valid())
                if len(geometry) < 2:
                    return
                _insert_segment(self.connection, osm_way_id=way.id, tags=tags, geometry=geometry)
                self.count += 1
                if self.count % 1_000 == 0:
                    self.connection.commit()

        return Handler()


def build_index(pbf: str | Path, database: str | Path) -> int:
    """Rebuild the semantic-road SQLite index from one OSM PBF."""
    try:
        import osmium
    except ImportError as exc:  # pragma: no cover - environment-level error
        raise RuntimeError("Install pyosmium first: python -m pip install osmium") from exc
    relations = collect_named_road_relations(pbf)
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    connection = _connect(database)
    try:
        create_schema(connection)
        for relation in relations:
            _insert_relation(connection, relation)
        connection.commit()
        route_member_ids = {member for relation in relations for member in relation.members}
        handler = SemanticRoadHandler(connection, route_member_ids)
        locations = osmium.NodeLocationsForWays(osmium.index.create_map("sparse_mem_array"))
        with osmium.io.Reader(str(pbf), osmium.osm.NODE | osmium.osm.WAY) as reader:
            osmium.apply(reader, locations, handler)
        connection.commit()
        return handler.count
    finally:
        connection.close()


def _matching_rows(connection: sqlite3.Connection, query: str) -> list[sqlite3.Row]:
    normalized = normalize(query)
    if not normalized:
        raise ValueError("query must not be empty")
    pattern = f"%{normalized}%"
    select = """SELECT DISTINCT s.*, rr.osm_relation_id, rr.name AS relation_name, rr.ref AS relation_ref
                FROM road_segments s
                LEFT JOIN road_relation_members rm ON rm.osm_way_id = s.osm_way_id
                LEFT JOIN road_relations rr ON rr.osm_relation_id = rm.osm_relation_id"""
    initial = connection.execute(
        f"""{select}
            WHERE s.normalized_name LIKE ? OR s.normalized_ref LIKE ?
               OR rr.normalized_name LIKE ? OR rr.normalized_ref LIKE ?
            LIMIT ?""",
        (pattern, pattern, pattern, pattern, MAX_QUERY_ROWS),
    ).fetchall()
    if not initial:
        return []

    # One human road normally consists of many OSM ways.  A named fragment
    # such as "春风十里路" must pull in adjacent unnamed fragments that share
    # its ref or its route relation, otherwise a planner sees broken corridors.
    refs = {normalize(str(row["ref"] or row["relation_ref"] or "")) for row in initial}
    refs.discard("")
    relation_ids = {int(row["osm_relation_id"]) for row in initial if row["osm_relation_id"] is not None}
    clauses: list[str] = []
    values: list[Any] = []
    if refs:
        placeholders = ",".join("?" for _ in refs)
        clauses.append(f"s.normalized_ref IN ({placeholders})")
        values.extend(sorted(refs))
        clauses.append(f"rr.normalized_ref IN ({placeholders})")
        values.extend(sorted(refs))
    if relation_ids:
        placeholders = ",".join("?" for _ in relation_ids)
        clauses.append(f"rm.osm_relation_id IN ({placeholders})")
        values.extend(sorted(relation_ids))
    if not clauses:
        return initial
    return connection.execute(
        f"{select} WHERE {' OR '.join(clauses)} LIMIT ?",
        (*values, MAX_QUERY_ROWS),
    ).fetchall()


def _corridor_key(row: sqlite3.Row) -> tuple[str, str]:
    ref = row["ref"] or row["relation_ref"]
    if ref:
        return "ref", normalize(str(ref))
    name = row["name"] or row["relation_name"]
    return "name", normalize(str(name))


def _anchor_points(geometries: Iterable[Sequence[tuple[float, float]]], *, maximum: int = 8) -> tuple[tuple[float, float], ...]:
    anchors: list[tuple[float, float]] = []
    for geometry in geometries:
        for point in (geometry[0], geometry[len(geometry) // 2], geometry[-1]):
            if point not in anchors:
                anchors.append(point)
    return tuple(anchors[:maximum])


def _to_corridors(rows: Sequence[sqlite3.Row], *, point: tuple[float, float] | None = None) -> list[RoadCorridor]:
    grouped: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        grouped[_corridor_key(row)].append(row)
    corridors = []
    for group_rows in grouped.values():
        first = group_rows[0]
        geometries = [decode_geometry(row["geometry"]) for row in group_rows]
        name = next((row["name"] or row["relation_name"] for row in group_rows if row["name"] or row["relation_name"]), None)
        ref = next((row["ref"] or row["relation_ref"] for row in group_rows if row["ref"] or row["relation_ref"]), None)
        distances = [distance_to_geometry_m(point, geometry) for geometry in geometries] if point else []
        corridors.append(RoadCorridor(
            name=str(name) if name else None,
            ref=str(ref) if ref else None,
            highway_classes=tuple(sorted({str(row["highway"]) for row in group_rows})),
            osm_way_ids=tuple(sorted({int(row["osm_way_id"]) for row in group_rows})),
            relation_ids=tuple(sorted({int(row["osm_relation_id"]) for row in group_rows if row["osm_relation_id"] is not None})),
            anchors=_anchor_points(geometries),
            distance_m=min(distances) if distances else None,
        ))
    return corridors


def search_road_corridors(database: str | Path, query: str, *, limit: int = 8) -> list[RoadCorridor]:
    connection = _connect(database)
    try:
        corridors = _to_corridors(_matching_rows(connection, query))
    finally:
        connection.close()
    normalized = normalize(query)
    return sorted(
        corridors,
        key=lambda item: (
            0 if normalize(item.ref) == normalized or normalize(item.name) == normalized else 1,
            item.name or "", item.ref or "",
        ),
    )[:limit]


def nearby_road_corridors(
    database: str | Path,
    *,
    lat: float,
    lon: float,
    radius_m: float = 5_000.0,
    limit: int = 20,
) -> list[RoadCorridor]:
    if radius_m <= 0 or radius_m > 50_000:
        raise ValueError("radius_m must be between 1 and 50000")
    lat_delta = radius_m / 111_320.0
    lon_delta = radius_m / (111_320.0 * max(math.cos(math.radians(lat)), 0.01))
    connection = _connect(database)
    try:
        rows = connection.execute(
            """SELECT s.*, rr.osm_relation_id, rr.name AS relation_name, rr.ref AS relation_ref
               FROM road_segments s
               JOIN road_segment_rtree rt ON rt.id = s.id
               LEFT JOIN road_relation_members rm ON rm.osm_way_id = s.osm_way_id
               LEFT JOIN road_relations rr ON rr.osm_relation_id = rm.osm_relation_id
               WHERE rt.min_lat <= ? AND rt.max_lat >= ?
                 AND rt.min_lon <= ? AND rt.max_lon >= ?
               LIMIT ?""",
            (lat + lat_delta, lat - lat_delta, lon + lon_delta, lon - lon_delta, MAX_QUERY_ROWS),
        ).fetchall()
        corridors = _to_corridors(rows, point=(lat, lon))
    finally:
        connection.close()
    return sorted(
        (item for item in corridors if item.distance_m is not None and item.distance_m <= radius_m),
        key=lambda item: (item.distance_m, item.name or "", item.ref or ""),
    )[:limit]


def _point(value: str) -> tuple[float, float]:
    try:
        lat, lon = (float(part.strip()) for part in value.split(",", 1))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("point must be 'lat,lon'") from exc
    return lat, lon


def main() -> None:
    parser = argparse.ArgumentParser(description="Build and search local semantic OSM road corridors")
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--pbf", type=Path, required=True)
    build.add_argument("--database", type=Path, required=True)
    search = commands.add_parser("search")
    search.add_argument("query")
    search.add_argument("--database", type=Path, required=True)
    search.add_argument("--limit", type=int, default=8)
    nearby = commands.add_parser("nearby")
    nearby.add_argument("--point", type=_point, required=True)
    nearby.add_argument("--database", type=Path, required=True)
    nearby.add_argument("--radius-m", type=float, default=5_000.0)
    nearby.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    if args.command == "build":
        print(json.dumps({"indexed": build_index(args.pbf, args.database)}, ensure_ascii=False))
    elif args.command == "search":
        print(json.dumps([item.as_dict() for item in search_road_corridors(args.database, args.query, limit=args.limit)], ensure_ascii=False, indent=2))
    else:
        lat, lon = args.point
        print(json.dumps([item.as_dict() for item in nearby_road_corridors(args.database, lat=lat, lon=lon, radius_m=args.radius_m, limit=args.limit)], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
