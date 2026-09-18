"""Prepare bounded route skeletons before any routing API call.

Coordinates are provider-owned WGS84; connector distances are lower-bound
estimates, never route distances. No plan or database mutation happens here.
"""
from copy import deepcopy
from itertools import combinations, permutations
import math
import time
import unicodedata

from integrations.strava import StravaSink
from integrations.google_places import GooglePlacesClient
from integrations.route_providers.strava_segments import segment_detail_feature
from services.route.geometry import haversine_m
from services.route.materials import validate_materials
from services.route.single_day import resolve_google_places, _search_amap_place, RouteCandidateRejected
from settings import load_config


def resolve_material_points(materials, *, config):
    """Resolve once, retaining native provider coordinates separately from WGS84."""
    by_id = {p["id"]: p for p in materials["points"]}
    ordered = [by_id[materials["origin_id"]], *[
        p for p in materials["points"] if p["id"] != materials["origin_id"]
    ]]
    resolved, cache, google_cache, anchor = {}, {}, {}, None
    country = materials["country_code"]
    locality_evidence = None
    if country != "CN" and materials.get("locality"):
        locality_evidence = resolve_google_locality(materials["locality"], country, config)
    for point in ordered:
        query = point["query"]
        if query not in cache:
            if country == "CN":
                key = str((config.get("amap") or {}).get("web_service_key") or "")
                if not key:
                    raise ValueError("amap.web_service_key is not configured")
                place = _search_amap_place(query, key, anchor=anchor,
                                           region=str((anchor or {}).get("citycode") or ""))
            else:
                queries = [query] if anchor is None else [anchor["query"], query]
                # A call-local cache also avoids resolving the origin repeatedly.
                place = resolve_google_places(
                    queries, country, materials["is_loop"], config,
                    target_distance_km=materials.get("target_distance_km"), place_cache=google_cache,
                )[-1]
            coordinate = [float(place.get("display_longitude", place["longitude"])),
                          float(place.get("display_latitude", place["latitude"]))]
            _valid_coordinate(coordinate)
            check_locality(place, materials.get("locality"), evidence=locality_evidence)
            cache[query] = {"place": place, "coordinate": coordinate}
        entry = cache[query]
        resolved[point["id"]] = {**point, **deepcopy(entry), "coordinate_system": "wgs84"}
        if locality_evidence:
            resolved[point["id"]]["locality_evidence"] = deepcopy(locality_evidence)
        if anchor is None:
            anchor = entry["place"]
    return resolved


def resolve_google_locality(locality, country, config):
    """Obtain canonical names from a city result, never model-supplied aliases."""
    client = GooglePlacesClient(str((config.get("google") or {}).get("api_key") or ""))
    results = client.search(f"{locality}, {country}", limit=5).get("places") or []
    cities = {p["id"]: p for p in results if p.get("id") and p.get("country_code") == country
              and "locality" in (p.get("types") or []) and p.get("localities")}
    if len(cities) != 1:
        raise RouteCandidateRejected(
            f"城市 {locality} 未取得唯一的 {country} 城市证据，请明确城市；不会用省/府或景点替代。",
            code="locality_unresolved", stage="place_resolution",
        )
    city = next(iter(cities.values()))
    # Retrieve another language for the same Place ID, not an unverified alias
    # table. Places may return English components even for a Chinese request.
    translated = client.search(f"{locality}, {country}", language_code="en", limit=5).get("places") or []
    same_city = [p for p in translated if p.get("id") == city["id"]
                 and p.get("country_code") == country and "locality" in (p.get("types") or [])]
    names = [*city["localities"], *[name for p in same_city for name in p.get("localities") or []]]
    return {"query": locality, "country_code": country, "place_id": city["id"],
            "names": list(dict.fromkeys(names)), "provider": "google_places"}


def check_locality(place, locality, *, evidence=None):
    """Fail closed on absent city evidence; province/prefecture is not a city."""
    if not locality:
        return
    def normalized(value):
        return unicodedata.normalize("NFKC", str(value)).strip().casefold().removesuffix("市")
    actual = place.get("localities") or []
    expected = [locality]
    if evidence:
        if place.get("country_code") != evidence["country_code"] or evidence["query"] != locality:
            raise RouteCandidateRejected("地点与城市证据的国家或查询不匹配", code="place_locality_mismatch", stage="place_resolution")
        expected = evidence["names"]
    if not {normalized(value) for value in expected} & {normalized(value) for value in actual}:
        raise RouteCandidateRejected(
            f"地点 {place.get('query', '')} 的城市证据 {actual or '缺失'} 不符合 {locality}；不得扩大到整个省/府。",
            code="place_locality_mismatch", stage="place_resolution",
        )


def _valid_coordinate(point):
    if len(point) != 2 or not all(math.isfinite(float(v)) for v in point):
        raise ValueError("invalid WGS84 coordinate")
    if not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90:
        raise ValueError("WGS84 coordinate out of range")


def discovery_bounds(origin, radius_km):
    lon, lat = origin
    dy = radius_km / 111.32
    dx = dy / max(0.05, math.cos(math.radians(lat)))
    return ",".join(str(v) for v in (max(-90, lat-dy), max(-180, lon-dx),
                                     min(90, lat+dy), min(180, lon+dx)))


def discover_optional_segments(origin, *, radius_km, config, enabled=True,
                               sink_factory=StravaSink, clock=time.monotonic):
    """One discovery and at most ten detail reads; no connectivity probe.

20s scheduling budget plus per-request timeout; requests' timeout is a socket
timeout, not a guarantee of wall-clock cancellation. Never expose raw errors
which may contain credentials or URLs.
"""
    if not enabled:
        return [], {"status": "disabled", "message": "本次未使用 Strava。"}
    deadline = clock() + 20
    cfg = deepcopy(config)
    cfg["strava"] = {**cfg.get("strava", {}), "timeout_seconds": 4, "segment_read_attempts": 1}
    stage = "connection"
    pool, failures = [], []
    try:
        sink = sink_factory(cfg)
        stage = "discovery"
        if clock() >= deadline:
            raise TimeoutError()
        sample = sink.explore_segments(discovery_bounds(origin, radius_km))
        seen = set()
        for item in (sample.get("segments") or [])[:10]:
            if clock() >= deadline:
                failures.append({"stage": "detail", "code": "budget_exhausted"})
                break
            try:
                segment_id = int(item["id"])
                if segment_id <= 0 or segment_id in seen:
                    continue
                seen.add(segment_id)
                feature = segment_detail_feature(sink.get_segment(segment_id))
                if feature["properties"]["id"] != segment_id:
                    raise ValueError("segment detail identity mismatch")
                coordinates = feature["geometry"]["coordinates"]
                if len(coordinates) > 20000:
                    raise ValueError("segment geometry exceeds budget")
                for coordinate in coordinates:
                    _valid_coordinate(coordinate)
                if feature["properties"].get("hazardous"):
                    continue
                if min(haversine_m(origin, coordinates[0]), haversine_m(origin, coordinates[-1])) > radius_km * 1000:
                    continue
                distance = sum(haversine_m(a, b) for a, b in zip(coordinates, coordinates[1:]))
                if distance <= 0:
                    continue
                pool.append({"segment_id": segment_id, "name": feature["properties"]["name"],
                             "geometry": feature["geometry"], "distance_m": distance,
                             "direction": "forward", "source": "strava_segment_detail",
                             "traversability": "unverified"})
            except Exception as exc:
                failures.append({"stage": "detail", "code": type(exc).__name__})
    except Exception as exc:
        return pool, {"status": "unavailable", "stage": stage, "code": type(exc).__name__,
                      "message": "Strava 暂不可用，本次继续使用地点和线路方向规划。"}
    status = "partial" if failures else "available" if pool else "empty"
    return pool, {"status": status, "count": len(pool), "failures": failures,
                  "message": "已获取可选 Strava 路段，尚未验证通行。" if pool else
                  "未取得合适的 Strava 路段，继续使用地点和线路方向规划。"}


def rank_skeletons(materials, points, segments=(), *, limit=3):
    """Bounded beam search over atomic point/corridor blocks, then segment inserts.

Required points keep their declared order. Corridor order is immutable. Strava
direction is preserved; geometry reversal cannot prove reverse travel is legal.
"""
    origin = materials["origin_id"]
    end = origin if materials["is_loop"] else materials["destination_id"]
    required = [p["id"] for p in materials["points"] if p["required"] and p["id"] not in {origin, end}]
    blocks = [[p["id"]] for p in materials["points"] if p["id"] not in {origin, end}]
    blocks += [c["point_ids"] for c in materials["corridors"]]
    target = materials.get("target_distance_km")

    def score(ids):
        coordinates = [points[i]["coordinate"] for i in [origin, *ids, end]]
        distance = sum(haversine_m(a, b) for a, b in zip(coordinates, coordinates[1:]))
        return abs(distance - target * 1000) if target else distance

    def valid(ids):
        full = [origin, *ids, end]
        if len(full) > 12 or len(set(full)) != len(full) - int(materials["is_loop"]):
            return False
        present_required = [p for p in ids if p in required]
        if present_required != [p for p in required if p in ids]:
            return False
        for corridor in materials["corridors"]:
            sequence = corridor["point_ids"]
            if all(p in full for p in sequence):
                # Adjacent control points preserve the named corridor as a block.
                if not any(full[i:i+len(sequence)] == sequence for i in range(len(full))):
                    return False
        return True

    beam, finished = [tuple()], set()
    for _ in range(10):
        expanded = set()
        for ids in beam:
            for block in blocks:
                middle = list(block)
                if middle and middle[0] == origin:
                    middle = middle[1:]
                if middle and middle[-1] == end:
                    middle = middle[:-1]
                if not middle or set(middle) & set(ids) or origin in middle or end in middle:
                    continue
                for index in range(len(ids)+1):
                    candidate = (*ids[:index], *middle, *ids[index:])
                    if valid(candidate):
                        expanded.add(candidate)
        beam = sorted(expanded, key=lambda ids: (score(ids), ids))[:64]
        finished.update(ids for ids in beam if set(required) <= set(ids) and all(
            not c["required"] or set(c["point_ids"]) <= {origin, *ids, end}
            for c in materials["corridors"]
        ))
        if not beam:
            break
    if not materials["is_loop"] and not required and not any(c["required"] for c in materials["corridors"]):
        finished.add(tuple())
    candidates = []
    for ids in sorted(finished, key=lambda ids: (score(ids), ids))[:limit]:
        point_ids = [origin, *ids, end]
        legs = [{"kind": "connector", "from": points[a]["coordinate"], "to": points[b]["coordinate"]}
                for a, b in zip(point_ids, point_ids[1:])]
        candidates.append(_skeleton(point_ids, legs, materials))
    # Insert one/two directed segments at a connector boundary. Never break
    # a corridor block or delete a mandatory point to improve an estimate.
    mixed = []
    for base in candidates:
        for size in (1, 2):
            for subset in combinations(segments[:10], size):
                for ordered in permutations(subset):
                    for index, leg in enumerate(base["legs"]):
                        a, b = base["point_ids"][index:index+2]
                        if any((a, b) in list(zip(c["point_ids"], c["point_ids"][1:])) for c in materials["corridors"]):
                            continue
                        replacement, current = [], leg["from"]
                        for segment in ordered:
                            geometry = segment["geometry"]["coordinates"]
                            replacement.extend([
                                {"kind": "connector", "from": current, "to": geometry[0]},
                                {"kind": "segment", "segment_id": segment["segment_id"],
                                 "direction": "forward", "distance_m": segment["distance_m"]},
                            ])
                            current = geometry[-1]
                        replacement.append({"kind": "connector", "from": current, "to": leg["to"]})
                        mixed.append(_skeleton(base["point_ids"], base["legs"][:index]+replacement+base["legs"][index+1:], materials))
    # Reserve point-only alternatives: optional Strava must not crowd them out.
    selected = candidates + sorted(mixed, key=lambda s: (s["score"], repr(s["legs"])))[:limit]
    for index, candidate in enumerate(selected, 1):
        candidate["skeleton_id"] = f"s{index}"
    return selected


def _skeleton(point_ids, legs, materials):
    distance = sum(leg["distance_m"] if leg["kind"] == "segment" else
                   haversine_m(leg["from"], leg["to"]) for leg in legs)
    target = materials.get("target_distance_km")
    return {"point_ids": list(point_ids), "legs": legs, "estimated_distance_m": round(distance, 1),
            "score": abs(distance-target*1000) if target else distance,
            "distance_kind": "geometry_plus_straight_connectors", "validation_status": "pending",
            "corridor_ids": [c["id"] for c in materials["corridors"] if set(c["point_ids"]) <= set(point_ids)]}


def prepare_route_materials(value, *, sources=(), use_strava=True, config=None,
                            resolver=None, discoverer=None):
    if not isinstance(use_strava, bool):
        raise ValueError("use_strava must be a boolean")
    materials = validate_materials(value, source_ids=[s["source_id"] for s in sources])
    cfg = config if config is not None else load_config()
    points = (resolver or resolve_material_points)(materials, config=cfg)
    origin = points[materials["origin_id"]]["coordinate"]
    radius = min(20, max(2, (materials.get("target_distance_km") or 20) / 2))
    segments, status = (discoverer or discover_optional_segments)(origin, radius_km=radius, config=cfg, enabled=use_strava)
    skeletons = rank_skeletons(materials, points, segments)
    if not skeletons:
        raise ValueError("无法组合保留必经点和线路方向的骨架，请调整材料。")
    return {"schema_version": "route_preparation.v1", "status": "prepared", "materials": materials,
            "points": points, "segments": segments, "strava": status, "skeletons": skeletons,
            "notice": "仅为待验证骨架，估算距离不代表实际路线距离；没有生成或保存路线。"}


def create_prepared_plan(preparation, *, workspace_id, title, include_elevation,
                         route_constraints=None, route_preferences=None):
    """Temporary bridge for point skeletons only; mixed validation is phase three."""
    from services.route.single_day import create_single_day_plan
    materials = preparation["materials"]
    candidates = []
    for skeleton in preparation["skeletons"]:
        if any(leg["kind"] == "segment" for leg in skeleton["legs"]):
            continue
        points = [preparation["points"][pid] for pid in skeleton["point_ids"]]
        candidates.append({"name": f"本地候选 {len(candidates)+1}",
                           "waypoints": [p["query"] for p in points],
                           "target_distance_km": materials.get("target_distance_km"),
                           "_resolved_places": [deepcopy(p["place"]) for p in points]})
    plan = create_single_day_plan(
        workspace_id=workspace_id, title=title, country_code=materials["country_code"],
        candidates=candidates, include_elevation=include_elevation,
        route_constraints=route_constraints, route_preferences=route_preferences,
    )
    plan["route_preparation"] = deepcopy(preparation)
    message = preparation["strava"]["message"]
    if preparation["segments"]:
        message += " 当前地图验证仅使用地点骨架，未采用 Strava 混合骨架。"
    for candidate in plan.get("candidates", []):
        candidate.setdefault("warnings", []).append(message)
    return plan
