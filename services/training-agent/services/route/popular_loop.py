"""Build a domestic route around one complete, popular Strava loop."""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from typing import Any
from uuid import uuid4

from demo.gaode_cycling_router.amap import AmapCyclingRouter, AmapPoint
from demo.gaode_cycling_router.coordinates import gcj02_to_wgs84, wgs84_to_gcj02
from demo.osm_cycling_router.segment_loop import haversine_m
from demo.osm_cycling_router.strava_segments import segment_detail_feature
from demo.global_cycling_router.google_places import GooglePlacesClient
from integrations.strava import StravaSink
from services.route.segment_aware import build_connector_router
from services.route.single_day import _elevation_profile, _search_amap_place, create_single_day_plan
from settings import load_config


PlaceSearcher = Callable[[str, str], dict[str, Any]]
SegmentExplorer = Callable[[str], dict[str, Any]]
SegmentFetcher = Callable[[int], dict[str, Any]]
ConnectorRouter = Callable[[Sequence[float], Sequence[float]], dict[str, Any]]
ElevationFetcher = Callable[[Sequence[Sequence[float]], float, dict[str, Any]], dict[str, Any]]


def create_popular_loop_plan(
    *,
    workspace_id: str,
    title: str,
    country_code: str = "CN",
    origin: str,
    area: str,
    segment_name_hint: str = "",
    target_distance_km: float | None = None,
    search_radius_km: float = 8.0,
    include_elevation: bool = True,
    fallback_to_provider: bool = True,
    config: dict[str, Any] | None = None,
    place_searcher: PlaceSearcher | None = None,
    segment_explorer: SegmentExplorer | None = None,
    segment_fetcher: SegmentFetcher | None = None,
    connector_router: ConnectorRouter | None = None,
    elevation_fetcher: ElevationFetcher | None = None,
) -> dict[str, Any]:
    """Use one complete closed Segment as the route body and map routing for access.

    Strava Explorer is deliberately used only for bounded discovery.  The
    chosen Segment detail supplies the actual loop geometry; AMap does not
    replace or approximate that geometry.
    """
    normalized_origin = str(origin or "").strip()
    normalized_area = str(area or "").strip()
    normalized_country = str(country_code or "").strip().upper()
    if len(normalized_country) != 2:
        raise ValueError("country_code must be a two-letter ISO code")
    if not normalized_origin or not normalized_area:
        raise ValueError("origin and area are required")
    radius_km = float(search_radius_km)
    if not 0.5 <= radius_km <= 20:
        raise ValueError("search_radius_km must be between 0.5 and 20")
    cfg = config if config is not None else load_config()
    amap = cfg.get("amap") if isinstance(cfg.get("amap"), dict) else {}
    google = cfg.get("google") if isinstance(cfg.get("google"), dict) else {}
    amap_key = str(amap.get("web_service_key") or "")
    google_key = str(google.get("api_key") or "")
    provider_key = amap_key if normalized_country == "CN" else google_key
    if not provider_key:
        setting = "amap.web_service_key" if normalized_country == "CN" else "google.api_key"
        raise ValueError(f"{setting} is not configured")
    search = place_searcher or (
        _search_amap_place if normalized_country == "CN" else _google_place_searcher(normalized_country)
    )
    origin_place = search(normalized_origin, provider_key)
    area_place = search(normalized_area, provider_key)

    try:
        sink = None
        if segment_explorer is None or segment_fetcher is None:
            sink = StravaSink(cfg)
        explore = segment_explorer or sink.explore_segments
        fetch = segment_fetcher or sink.get_segment
        bounds = _bounds_for_place(area_place, radius_km)
        sample = explore(bounds)
        origin_wgs = _display_coordinate(origin_place)
        ranked_segments = _rank_closed_segments(
            sample.get("segments") or [],
            name_hint=str(segment_name_hint or "").strip(),
            target_distance_km=target_distance_km,
            origin=origin_wgs,
        )
        route_connector = connector_router or build_connector_router(
            country_code=normalized_country, amap_key=amap_key, google_key=google_key,
        )
        last_candidate_error: Exception | None = None
        candidates: list[dict[str, Any]] = []
        target = float(target_distance_km) if target_distance_km is not None else None
        for selected in ranked_segments[:3]:
            try:
                detail = fetch(int(selected["id"]))
                feature = segment_detail_feature(detail)
                coordinates = [list(point) for point in feature["geometry"]["coordinates"]]
                closure_gap_m = haversine_m(coordinates[0], coordinates[-1])
                segment_distance_m = float(feature["properties"].get("distance_m") or detail.get("distance") or 0)
                if closure_gap_m > 1_000 or closure_gap_m / max(1.0, segment_distance_m) > 0.10:
                    raise ValueError(f"选中的 Strava 路段不是闭合环线（缺口 {closure_gap_m:.0f} m）")
                outbound = route_connector(origin_wgs, coordinates[0])
                inbound = route_connector(coordinates[-1], origin_wgs)
                geometry = _join_lines(
                    outbound["geometry"]["coordinates"], coordinates, inbound["geometry"]["coordinates"],
                )
                distance_m = (
                    float(outbound.get("distance_m") or 0)
                    + segment_distance_m
                    + float(inbound.get("distance_m") or 0)
                )
                duration_s = (
                    float(outbound.get("duration_s") or 0)
                    + segment_distance_m / 5.0
                    + float(inbound.get("duration_s") or 0)
                )
                segment = _segment_summary(detail, feature, closure_gap_m)
                candidates.append({
                    "candidate_id": f"candidate_{len(candidates) + 1}",
                    "candidate_kind": "popular_loop",
                    "name": str(detail.get("name") or feature["properties"].get("name") or normalized_area),
                    "route_type": "loop",
                    "waypoint_queries": [normalized_origin, normalized_area],
                    "waypoints": [origin_place, _segment_waypoint(normalized_area, area_place, coordinates[0]), dict(origin_place)],
                    "provider": f"{'amap' if normalized_country == 'CN' else 'google_routes'}+strava",
                    "travel_mode": "BICYCLE" if normalized_country != "JP" else "DRIVE",
                    "distance_m": distance_m,
                    "distance_km": round(distance_m / 1_000, 1),
                    "duration_s": duration_s,
                    "duration_min": round(duration_s / 60),
                    "target_distance_km": target,
                    "distance_delta_km": round(distance_m / 1_000 - target, 1) if target is not None else None,
                    "geometry": {"type": "LineString", "coordinates": geometry},
                    # Elevation is fetched only after the rider confirms one candidate.
                    "elevation": None,
                    "warnings": ["路线主体采用完整 Strava 热门环线；起点往返环线入口由地图服务接驳。"],
                    "strava_segments": [segment],
                    "rationale": f"完整骑行 Strava 环线“{segment['name']}”",
                    "segment_evidence": {
                        "strategy": "complete_popular_loop",
                        "selected_segment_id": segment["segment_id"],
                        "selected_segment_name": segment["name"],
                        "segment_distance_km": segment["distance_km"],
                        "closure_gap_m": segment["closure_gap_m"],
                        "approach_out_km": round(float(outbound.get("distance_m") or 0) / 1_000, 1),
                        "approach_back_km": round(float(inbound.get("distance_m") or 0) / 1_000, 1),
                        "search_bounds_wgs84": bounds,
                    },
                })
            except Exception as exc:
                last_candidate_error = exc
        if not candidates:
            raise RuntimeError(f"Strava 闭合环线候选均不可用：{last_candidate_error}") from last_candidate_error
        if target is not None:
            candidates.sort(key=lambda item: abs(float(item.get("distance_km") or 0) - target))
        for index, candidate in enumerate(candidates, start=1):
            candidate["candidate_id"] = f"candidate_{index}"
        plan = _plan(workspace_id, title, candidates[0], country_code=normalized_country, fallback=False)
        plan["candidates"] = candidates
        plan["active_candidate_id"] = candidates[0]["candidate_id"]
        plan["planning"] = {
            "status": "awaiting_selection",
            "confirmed_candidate_id": None,
            "include_elevation": bool(include_elevation),
        }
        plan["popular_loop_request"] = {
            "origin": normalized_origin,
            "area": normalized_area,
            "segment_name_hint": str(segment_name_hint or "").strip(),
            "target_distance_km": target_distance_km,
            "search_radius_km": radius_km,
            "country_code": normalized_country,
        }
        return plan
    except Exception as exc:
        if not fallback_to_provider:
            raise
        fallback = create_single_day_plan(
            workspace_id=workspace_id,
            title=title,
            country_code=normalized_country,
            candidates=[{
                "name": f"{normalized_area}普通往返",
                "waypoints": [normalized_origin, normalized_area, normalized_origin],
                "target_distance_km": target_distance_km,
            }],
            include_elevation=include_elevation,
        )
        fallback["route_mode"] = "popular_loop_fallback"
        fallback["segment_strategy"] = "complete_popular_loop"
        fallback["popular_loop_error"] = {"type": type(exc).__name__, "message": str(exc)}
        fallback_candidate = fallback["candidates"][0]
        fallback_candidate["candidate_kind"] = "provider_fallback"
        fallback_candidate["warnings"] = [
            *(fallback_candidate.get("warnings") or []),
            f"未找到或无法连接完整 Strava 热门环线，已降级为普通地图往返路线：{exc}",
        ]
        fallback["planning"] = {
            "status": "awaiting_selection",
            "confirmed_candidate_id": None,
            "include_elevation": bool(include_elevation),
        }
        return fallback


def reverse_popular_loop_plan(plan: dict[str, Any], *, candidate_id: str | None = None) -> dict[str, Any]:
    """Reverse a stored popular-loop geometry without replacing it by generic routing."""
    if plan.get("route_mode") != "popular_loop":
        raise ValueError("reverse_popular_loop_plan requires a popular loop plan")
    selected_id = str(candidate_id or plan.get("active_candidate_id") or "")
    candidates = [item for item in plan.get("candidates") or [] if isinstance(item, dict)]
    selected = next((item for item in candidates if str(item.get("candidate_id") or "") == selected_id), None)
    if selected is None:
        raise ValueError("route candidate does not exist")
    geometry = selected.get("geometry") if isinstance(selected.get("geometry"), dict) else {}
    coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
    if len(coordinates) < 2:
        raise ValueError("popular loop has no reversible geometry")
    segments = []
    for segment in selected.get("strava_segments") or []:
        if not isinstance(segment, dict):
            continue
        segment_geometry = segment.get("geometry") if isinstance(segment.get("geometry"), dict) else {}
        segment_coordinates = segment_geometry.get("coordinates") if isinstance(segment_geometry.get("coordinates"), list) else []
        segments.append({
            **segment,
            "route_direction": "reverse" if segment.get("route_direction") != "reverse" else "forward",
            "geometry": {
                **segment_geometry,
                "coordinates": list(reversed(segment_coordinates)),
            },
        })
    waypoints = [dict(item) for item in selected.get("waypoints") or [] if isinstance(item, dict)]
    if len(waypoints) >= 2 and segments:
        segment_coordinates = segments[0]["geometry"].get("coordinates") or []
        if segment_coordinates:
            waypoints[1]["longitude"] = float(segment_coordinates[0][0])
            waypoints[1]["latitude"] = float(segment_coordinates[0][1])
    elevation = selected.get("elevation") if isinstance(selected.get("elevation"), dict) else None
    if elevation and isinstance(elevation.get("elevations_m"), list):
        elevation = {**elevation, "elevations_m": list(reversed(elevation["elevations_m"]))}
    evidence = dict(selected.get("segment_evidence") or {})
    evidence["approach_out_km"], evidence["approach_back_km"] = (
        evidence.get("approach_back_km"), evidence.get("approach_out_km"),
    )
    updated = {
        **selected,
        "geometry": {**geometry, "coordinates": list(reversed(coordinates))},
        "waypoints": waypoints,
        "elevation": elevation,
        "strava_segments": segments,
        "segment_evidence": evidence,
        "warnings": [*(selected.get("warnings") or []), "已反转整条热门环线和接驳方向。"],
    }
    return {
        **plan,
        "candidates": [updated if item is selected else item for item in candidates],
        "planning": {
            **(plan.get("planning") if isinstance(plan.get("planning"), dict) else {}),
            "status": "awaiting_selection",
            "confirmed_candidate_id": None,
        },
    }


def _plan(
    workspace_id: str, title: str, candidate: dict[str, Any], *, country_code: str, fallback: bool,
) -> dict[str, Any]:
    return {
        "schema_version": "route_plan.v1",
        "plan_id": f"route_{uuid4().hex}",
        "workspace_id": str(workspace_id),
        "revision": 0,
        "title": str(title or "热门环线"),
        "day_count": 1,
        "country_code": country_code,
        "route_mode": "popular_loop_fallback" if fallback else "popular_loop",
        "segment_strategy": "complete_popular_loop",
        "active_candidate_id": candidate["candidate_id"],
        "candidates": [candidate],
    }


def _bounds_for_place(place: dict[str, Any], radius_km: float) -> str:
    lon, lat = _display_coordinate(place)
    lat_delta = radius_km / 111.0
    lon_delta = radius_km / max(20.0, 111.0 * math.cos(math.radians(lat)))
    return f"{lat - lat_delta:.6f},{lon - lon_delta:.6f},{lat + lat_delta:.6f},{lon + lon_delta:.6f}"


def _display_coordinate(place: dict[str, Any]) -> list[float]:
    return [
        float(place.get("display_longitude", place["longitude"])),
        float(place.get("display_latitude", place["latitude"])),
    ]


def _rank_closed_segments(
    segments: Sequence[dict[str, Any]],
    *,
    name_hint: str,
    target_distance_km: float | None,
    origin: Sequence[float] | None = None,
) -> list[dict[str, Any]]:
    closed = []
    normalized_hint = "".join(name_hint.casefold().split())
    for index, segment in enumerate(segments):
        start, end = segment.get("start_latlng"), segment.get("end_latlng")
        if not (isinstance(start, list) and isinstance(end, list) and len(start) >= 2 and len(end) >= 2):
            continue
        gap = haversine_m((start[1], start[0]), (end[1], end[0]))
        distance_km = float(segment.get("distance") or 0) / 1_000
        if gap > 1_000 or gap / max(1.0, distance_km * 1_000) > 0.10:
            continue
        name = "".join(str(segment.get("name") or "").casefold().split())
        name_match = _name_match_score(normalized_hint, name)
        connector_km = 0.0
        if origin is not None:
            connector_km = (
                haversine_m(origin, (start[1], start[0]))
                + haversine_m((end[1], end[0]), origin)
            ) / 1_000 * 1.25
        target_error = (
            abs(distance_km + connector_km - float(target_distance_km))
            if target_distance_km is not None else 0
        )
        popularity = float(segment.get("star_count") or segment.get("athlete_count") or 0)
        closed.append(((name_match, -target_error, popularity, -gap, -index), segment))
    if not closed:
        raise ValueError("Strava Explorer 在指定区域没有返回闭合骑行环线")
    if normalized_hint and not any(score[0] for score, _ in closed):
        raise ValueError(f"未找到名称匹配“{name_hint}”的闭合 Strava 环线")
    return [segment for _, segment in sorted(closed, key=lambda item: item[0], reverse=True)]


def _select_closed_segment(
    segments: Sequence[dict[str, Any]], *, name_hint: str, target_distance_km: float | None,
) -> dict[str, Any]:
    """Compatibility wrapper for callers that need only the first candidate."""
    return _rank_closed_segments(
        segments, name_hint=name_hint, target_distance_km=target_distance_km,
    )[0]


def _name_match_score(hint: str, name: str) -> int:
    if not hint:
        return 0
    if hint in name or name in hint:
        return 3
    hint_pairs = {hint[index:index + 2] for index in range(max(0, len(hint) - 1))}
    name_pairs = {name[index:index + 2] for index in range(max(0, len(name) - 1))}
    return 2 if hint_pairs & name_pairs else 0


def _amap_connector(key: str) -> ConnectorRouter:
    router = AmapCyclingRouter(key)

    def route(origin: Sequence[float], destination: Sequence[float]) -> dict[str, Any]:
        origin_gcj = wgs84_to_gcj02(float(origin[0]), float(origin[1]))
        destination_gcj = wgs84_to_gcj02(float(destination[0]), float(destination[1]))
        result = router.route(AmapPoint(origin_gcj[1], origin_gcj[0]), AmapPoint(destination_gcj[1], destination_gcj[0]))
        return {
            **result,
            "geometry": {
                "type": "LineString",
                "coordinates": [list(gcj02_to_wgs84(lon, lat)) for lon, lat in result["geometry"]],
            },
        }

    return route


def _google_place_searcher(country_code: str) -> PlaceSearcher:
    def search(query: str, key: str) -> dict[str, Any]:
        places = GooglePlacesClient(key).search(query, limit=5).get("places") or []
        matching = [item for item in places if str(item.get("country_code") or "").upper() == country_code]
        selected = (matching or places)[0] if (matching or places) else None
        if not isinstance(selected, dict):
            raise RuntimeError(f"地点检索没有结果：{query}")
        location = selected.get("location") if isinstance(selected.get("location"), dict) else {}
        return {
            "query": query,
            "name": selected.get("name") or query,
            "address": selected.get("address") or "",
            "latitude": float(location["latitude"]),
            "longitude": float(location["longitude"]),
        }

    return search


def _join_lines(*lines: Sequence[Sequence[float]]) -> list[list[float]]:
    result: list[list[float]] = []
    for line in lines:
        for point in line:
            normalized = [float(point[0]), float(point[1])]
            if not result or normalized != result[-1]:
                result.append(normalized)
    if len(result) < 2:
        raise ValueError("route geometry contains insufficient points")
    return result


def _segment_waypoint(query: str, area_place: dict[str, Any], coordinate: Sequence[float]) -> dict[str, Any]:
    return {
        "query": query,
        "name": f"{area_place.get('name') or query} · Strava 环线入口",
        "address": area_place.get("address") or "",
        "latitude": float(coordinate[1]),
        "longitude": float(coordinate[0]),
    }


def _segment_summary(detail: dict[str, Any], feature: dict[str, Any], closure_gap_m: float) -> dict[str, Any]:
    properties = feature["properties"]
    return {
        "segment_id": int(properties["id"]),
        "name": str(properties["name"]),
        "distance_km": round(float(properties.get("distance_m") or 0) / 1_000, 1),
        "elevation_difference_m": round(float(properties.get("ascend_m") or 0), 1),
        "average_grade_percent": properties.get("average_grade"),
        "maximum_grade_percent": properties.get("maximum_grade"),
        "climb_category": properties.get("climb_category"),
        "closure_gap_m": round(closure_gap_m, 1),
        "effort_count": detail.get("effort_count"),
        "athlete_count": detail.get("athlete_count"),
        "star_count": detail.get("star_count"),
        "geometry": feature["geometry"],
    }
