"""Prepare bounded route skeletons before any routing API call.

Coordinates are provider-owned WGS84; connector distances are lower-bound
estimates, never route distances. No plan or database mutation happens here.
"""
from copy import deepcopy
import math
import time
import unicodedata

from integrations.strava import StravaSink
from integrations.google_places import GooglePlacesClient
from integrations.route_providers.strava_segments import segment_detail_feature
from services.route.geometry import haversine_m
from services.route.materials import validate_materials
from services.route.skeleton_search import rank_skeletons
from services.route.single_day import resolve_google_places, _search_amap_place, RouteCandidateRejected
from settings import load_config
from services.route.provider_readiness import use_amap_routes


def resolve_material_points(materials, *, config):
    """Resolve once, retaining native provider coordinates separately from WGS84."""
    by_id = {p["id"]: p for p in materials["points"]}
    ordered = [by_id[materials["origin_id"]], *[
        p for p in materials["points"] if p["id"] != materials["origin_id"]
    ]]
    resolved, cache, google_cache, anchor = {}, {}, {}, None
    country = materials["country_code"]
    use_amap = use_amap_routes(country, config)
    scope = materials.get("locality_scope", "origin")
    target = materials.get("target_distance_km")
    point_radius = float(target) * (0.6 if materials["is_loop"] else 1.2) if target else 50.0
    locality_evidence = None
    if not use_amap and materials.get("locality"):
        locality_evidence = resolve_google_locality(materials["locality"], country, config)
    for point in ordered:
        query = point["query"]
        if query not in cache:
            if use_amap:
                key = str((config.get("amap") or {}).get("web_service_key") or "")
                if not key:
                    raise ValueError("amap.web_service_key is not configured")
                place = _search_amap_place(query, key, anchor=anchor,
                                           region=str((anchor or {}).get("citycode") or "") if scope == "city" else "")
            else:
                queries = [query] if anchor is None else [anchor["query"], query]
                # A call-local cache also avoids resolving the origin repeatedly.
                try:
                    place = resolve_google_places(
                        queries, country, materials["is_loop"], config,
                        target_distance_km=materials.get("target_distance_km"), place_cache=google_cache,
                        point_intents={p["query"]: p for p in ordered},
                        locality_names=tuple((locality_evidence or {}).get("names") or []),
                        locality_scope=scope, origin_locality_evidence=locality_evidence,
                        point_radius_km=point_radius,
                    )[-1]
                except RouteCandidateRejected as exc:
                    mandatory = (point.get("required") or point["id"] in {
                        materials["origin_id"], materials.get("destination_id"), *materials.get("ordered_point_ids", [])}
                        or any(c.get("required") and point["id"] in c["point_ids"] for c in materials.get("corridors", [])))
                    if mandatory or exc.code not in {"place_ambiguous", "place_not_found"}:
                        raise
                    continue
            coordinate = [float(place.get("display_longitude", place["longitude"])),
                          float(place.get("display_latitude", place["latitude"]))]
            _valid_coordinate(coordinate)
            if use_amap and anchor is not None:
                anchor_coordinate = [float(anchor.get("display_longitude", anchor["longitude"])),
                                     float(anchor.get("display_latitude", anchor["latitude"]))]
                if haversine_m(anchor_coordinate, coordinate) > point_radius * 1000:
                    raise RouteCandidateRejected(f"地点 {query} 超过起点范围 {point_radius:.1f} km",
                                                 code="place_outside_radius", stage="place_resolution")
            spatial_origin = (place.get("resolution_evidence") or {}).get("origin_locality_match") == "city_center_radius_5km"
            if (scope == "city" or anchor is None) and not (scope != "city" and anchor is None and spatial_origin):
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
            "names": list(dict.fromkeys(names)), "location": city.get("location"), "provider": "google_places"}


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


def prepare_route_materials(value, *, sources=(), use_strava=True, config=None,
                            resolver=None, discoverer=None):
    if not isinstance(use_strava, bool):
        raise ValueError("use_strava must be a boolean")
    materials = validate_materials(value, source_ids=[s["source_id"] for s in sources])
    from services.route.requirements import normalize_planning_requirements
    materials = normalize_planning_requirements(materials)
    cfg = config if config is not None else load_config()
    points = (resolver or resolve_material_points)(materials, config=cfg)
    unresolved = [p for p in materials["points"] if p["id"] not in points]
    if unresolved:
        materials["points"] = [p for p in materials["points"] if p["id"] in points]
        # Do not bridge a missing corridor anchor and claim continuous coverage.
        materials["corridors"] = [c for c in materials.get("corridors", []) if all(pid in points for pid in c["point_ids"])]
        materials = validate_materials(materials, source_ids=[s["source_id"] for s in sources])
    origin = points[materials["origin_id"]]["coordinate"]
    radius = min(20, max(2, (materials.get("target_distance_km") or 20) / 2))
    segments, status = (discoverer or discover_optional_segments)(origin, radius_km=radius, config=cfg, enabled=use_strava)
    skeletons = rank_skeletons(materials, points, segments, limit=24)
    if not skeletons:
        raise ValueError("无法组合保留必经点和线路方向的骨架，请调整材料。")
    return {"schema_version": "route_preparation.v1", "status": "prepared", "materials": materials,
            "unavailable_scenery": sorted(set(materials.get("scenery_preferences", [])) - {
                theme for corridor in materials.get("corridors", []) for theme in corridor.get("scenery", [])}),
            "points": points, "segments": segments, "strava": status, "skeletons": skeletons,
            "unresolved_optional_points": [{"id": p["id"], "query": p["query"]} for p in unresolved],
            "notice": "仅为待验证骨架，估算距离不代表实际路线距离；没有生成或保存路线。"}


def create_prepared_plan(preparation, *, workspace_id, title, include_elevation,
                         route_constraints=None, route_preferences=None, include_ascent=False):
    """Measure road skeletons, optionally compare ascent before selecting finalists."""
    from services.route.feedback import plan_with_feedback
    plan = plan_with_feedback(
        preparation, workspace_id=workspace_id, title=title, include_elevation=include_elevation,
        route_constraints=route_constraints, route_preferences=route_preferences, include_ascent=include_ascent,
    )
    plan["route_preparation"] = deepcopy(preparation)
    message = preparation["strava"]["message"]
    if preparation.get("unresolved_optional_points"):
        message += " 未能确定的可选地点及受影响走廊已移除：" + "、".join(p["query"] for p in preparation["unresolved_optional_points"])
    for candidate in plan.get("candidates", []):
        candidate.setdefault("warnings", []).append(message)
        materials = preparation["materials"]
        if materials.get("distance_mode") == "default":
            candidate["warnings"].append("未指定距离，本次按默认约 30 km 规划；可继续调整。")
        if materials.get("scenery_preferences"):
            candidate["warnings"].append("景观偏好已用于材料和控制点选择，未验证沿线景观连续性或实际坡度。")
        if preparation.get("unavailable_scenery"):
            labels = {"mountain": "山区", "riverside": "沿河", "forest": "林地", "coast": "海岸", "countryside": "乡村", "urban": "城区"}
            candidate["warnings"].append("当前材料缺少可用的" + "、".join(labels[x] for x in preparation["unavailable_scenery"])
                                         + "走廊，保留该偏好但不能确认本次候选满足。")
    return plan
