"""Verified single-day route plans built from the existing map-provider demos."""

from __future__ import annotations

import json
import math
import time
from collections.abc import Sequence
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener
from uuid import uuid4

from demo.gaode_cycling_router.amap import AmapCyclingRouter, AmapPoint
from demo.gaode_cycling_router.coordinates import gcj02_to_wgs84
from demo.global_cycling_router.google_places import GooglePlacesClient
from demo.global_cycling_router.google_routes import GoogleRoutesClient, WgsPoint
from settings import load_config


AMAP_PLACE_TEXT_URL = "https://restapi.amap.com/v5/place/text"
AMAP_PLACE_AROUND_URL = "https://restapi.amap.com/v5/place/around"
GOOGLE_ELEVATION_URL = "https://maps.googleapis.com/maps/api/elevation/json"
MIN_TARGET_DISTANCE_RATIO = 0.60
MAX_TARGET_DISTANCE_RATIO = 1.50
LOOP_WAYPOINT_RADIUS_RATIO = 0.75
MIN_LOOP_WAYPOINT_RADIUS_KM = 5.0
MAX_GOOGLE_PLACE_BIAS_RADIUS_M = 50_000.0


class RouteCandidateRejected(ValueError):
    """A provider-resolved candidate that violates deterministic route bounds."""


def create_single_day_plan(
    *,
    workspace_id: str,
    title: str,
    country_code: str,
    candidates: Sequence[dict[str, Any]],
    include_elevation: bool = True,
    plan_id: str | None = None,
) -> dict[str, Any]:
    """Resolve and route one or more explicit waypoint candidates."""
    normalized_country = str(country_code or "").strip().upper()
    if not normalized_country:
        raise ValueError("country_code is required")
    if not candidates:
        raise ValueError("at least one route candidate is required")
    if len(candidates) > 3:
        raise ValueError("at most three route candidates are supported")
    config = load_config()
    routed: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    for index, candidate in enumerate(candidates, start=1):
        try:
            routed.append(route_candidate(
                candidate,
                index=index,
                country_code=normalized_country,
                include_elevation=include_elevation,
                config=config,
            ))
        except RouteCandidateRejected as exc:
            rejected.append({
                "name": str(candidate.get("name") or f"候选路线 {index}"),
                "reason": str(exc),
            })
    if not routed:
        reasons = "；".join(f"{item['name']}：{item['reason']}" for item in rejected)
        raise RouteCandidateRejected(f"所有路线候选均超出合理范围。{reasons}")
    return {
        "schema_version": "route_plan.v1",
        "plan_id": plan_id or f"route_{uuid4().hex}",
        "workspace_id": str(workspace_id),
        "revision": 0,
        "title": str(title or "单日骑行路线"),
        "day_count": 1,
        "country_code": normalized_country,
        "active_candidate_id": routed[0]["candidate_id"],
        "candidates": routed,
        "rejected_candidates": rejected,
    }


def replace_candidate(
    plan: dict[str, Any],
    *,
    candidate_id: str | None,
    name: str,
    waypoint_queries: Sequence[str],
    target_distance_km: float | None,
    include_elevation: bool,
) -> dict[str, Any]:
    candidates = [item for item in plan.get("candidates") or [] if isinstance(item, dict)]
    selected_id = str(candidate_id or plan.get("active_candidate_id") or "")
    selected_index = next(
        (index for index, item in enumerate(candidates) if item.get("candidate_id") == selected_id),
        -1,
    )
    if selected_index < 0:
        raise ValueError("route candidate does not exist")
    normalized_queries, _ = normalize_waypoint_queries(waypoint_queries)
    spec = {
        "name": name or _waypoint_route_name(normalized_queries),
        "waypoints": normalized_queries,
        "target_distance_km": (
            target_distance_km
            if target_distance_km is not None
            else candidates[selected_index].get("target_distance_km")
        ),
        "candidate_id": selected_id,
    }
    updated = route_candidate(
        spec,
        index=selected_index + 1,
        country_code=str(plan.get("country_code") or ""),
        include_elevation=include_elevation,
        config=load_config(),
    )
    previous = candidates[selected_index]
    updated.update({
        "candidate_kind": "semantic_revision",
        "parent_candidate_id": previous.get("parent_candidate_id") or previous.get("candidate_id"),
        "rationale": "根据用户对当前候选的语义修改重新算路",
    })
    return {
        **plan,
        "title": updated["name"] if len(candidates) == 1 else plan.get("title"),
        "candidates": [updated if index == selected_index else item for index, item in enumerate(candidates)],
        "planning": {
            **(plan.get("planning") if isinstance(plan.get("planning"), dict) else {}),
            "status": "awaiting_selection",
            "confirmed_candidate_id": None,
        },
    }


def edit_candidate_waypoints(
    plan: dict[str, Any],
    *,
    candidate_id: str | None,
    operation: str,
    waypoint_index: int | None = None,
    new_waypoint: str | None = None,
    include_elevation: bool = True,
) -> dict[str, Any]:
    """Deterministically reverse or edit one saved single-day candidate."""
    candidates = [item for item in plan.get("candidates") or [] if isinstance(item, dict)]
    selected_id = str(candidate_id or plan.get("active_candidate_id") or "")
    selected = next(
        (item for item in candidates if str(item.get("candidate_id") or "") == selected_id),
        None,
    )
    if selected is None:
        raise ValueError("route candidate does not exist")
    queries = saved_waypoint_queries(selected)
    if operation == "reverse":
        queries = reverse_waypoint_queries(queries)
    elif operation == "replace_waypoint":
        if waypoint_index is None:
            raise ValueError("waypoint_index is required")
        index = int(waypoint_index) - 1
        if not 0 <= index < len(queries):
            raise ValueError(f"waypoint_index must be between 1 and {len(queries)}")
        replacement = str(new_waypoint or "").strip()
        if not replacement:
            raise ValueError("new_waypoint is required")
        queries[index] = replacement
    else:
        raise ValueError("operation must be reverse or replace_waypoint")
    return replace_candidate(
        plan,
        candidate_id=selected_id,
        name="",
        waypoint_queries=queries,
        target_distance_km=_optional_float(selected.get("target_distance_km")),
        include_elevation=include_elevation,
    )


def saved_waypoint_queries(route: dict[str, Any]) -> list[str]:
    queries = [str(value).strip() for value in route.get("waypoint_queries") or [] if str(value).strip()]
    if not queries:
        queries = [
            str(point.get("query") or point.get("name") or "").strip()
            for point in route.get("waypoints") or [] if isinstance(point, dict)
        ]
        queries = [value for value in queries if value]
    # Migrate old persisted loops whose waypoint_queries omitted the repeated
    # origin. New plans encode closure directly as A -> ... -> A.
    if (
        str(route.get("route_type") or "").lower() == "loop"
        and len(queries) > 1
        and _normalize_place_name(queries[-1]) != _normalize_place_name(queries[0])
    ):
        queries.append(queries[0])
    if len(queries) < 2:
        raise ValueError("saved route does not contain enough waypoint queries")
    return queries


def reverse_waypoint_queries(queries: list[str]) -> list[str]:
    normalized, is_closed = normalize_waypoint_queries(queries)
    if is_closed:
        return [normalized[0], *reversed(normalized[1:-1]), normalized[0]]
    return list(reversed(normalized))


def _waypoint_route_name(queries: Sequence[str]) -> str:
    names, _ = normalize_waypoint_queries(queries)
    if not names:
        return "更新路线"
    return " → ".join(names)


def normalize_waypoint_queries(values: Sequence[str]) -> tuple[list[str], bool]:
    """Return canonical ordered queries and whether they explicitly close."""
    queries = [str(value).strip() for value in values if str(value).strip()]
    is_closed = (
        len(queries) >= 3
        and _normalize_place_name(queries[0]) == _normalize_place_name(queries[-1])
    )
    if is_closed:
        queries[-1] = queries[0]
    return queries, is_closed


def compact_route_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Return the model-facing plan without route/elevation coordinate arrays."""
    candidates = []
    for item in plan.get("candidates") or []:
        if not isinstance(item, dict):
            continue
        stages = [stage for stage in item.get("stages") or [] if isinstance(stage, dict)]
        if stages:
            candidates.append({
                "candidate_id": item.get("candidate_id"),
                "name": item.get("name"),
                "distance_km": item.get("distance_km"),
                "duration_min": item.get("duration_min"),
                "day_summaries": item.get("day_summaries") or [],
                "maximum_day_distance_deviation_ratio": item.get("maximum_day_distance_deviation_ratio"),
                "warnings": item.get("warnings") or [],
                "stages": [_compact_route_segment(stage, id_key="stage_id") for stage in stages],
            })
        else:
            candidates.append(_compact_route_segment(item, id_key="candidate_id"))
    return {
        "schema_version": "route_plan.v1",
        "plan_id": plan.get("plan_id"),
        "workspace_id": plan.get("workspace_id"),
        "revision": plan.get("revision"),
        "title": plan.get("title"),
        "schedule_type": plan.get("schedule_type") or "single_day",
        "day_count": plan.get("day_count") or 1,
        "country_code": plan.get("country_code"),
        "route_mode": plan.get("route_mode"),
        "popular_loop_request": plan.get("popular_loop_request") or {},
        "popular_loop_error": plan.get("popular_loop_error") or {},
        "handoff_tolerance_km": plan.get("handoff_tolerance_km"),
        "segment_strategy": plan.get("segment_strategy") or "ignore",
        "segment_preferences": plan.get("segment_preferences") or [],
        "segment_aware_summary": plan.get("segment_aware_summary") or {},
        "planning": plan.get("planning") or {},
        "segment_pool": {
            str(target_id): [
                {key: value for key, value in segment.items() if key != "geometry"}
                for segment in segments if isinstance(segment, dict)
            ]
            for target_id, segments in (plan.get("segment_pool") or {}).items()
            if isinstance(segments, list)
        } if isinstance(plan.get("segment_pool"), dict) else {},
        "active_candidate_id": plan.get("active_candidate_id"),
        "candidates": candidates,
        "rejected_candidates": plan.get("rejected_candidates") or [],
    }


def _compact_route_segment(item: dict[str, Any], *, id_key: str) -> dict[str, Any]:
    elevation = item.get("elevation") if isinstance(item.get("elevation"), dict) else {}
    result = {
        id_key: item.get(id_key),
        "name" if id_key == "candidate_id" else "label": (
            item.get("name") if id_key == "candidate_id" else item.get("label")
        ),
        "route_type": item.get("route_type"),
        "is_closed": bool(item.get("is_closed") or item.get("route_type") == "loop"),
        "waypoints": item.get("waypoints") or [],
        "distance_km": item.get("distance_km"),
        "duration_min": item.get("duration_min"),
        "provider": item.get("provider"),
        "travel_mode": item.get("travel_mode"),
        "target_distance_km": item.get("target_distance_km"),
        "distance_delta_km": item.get("distance_delta_km"),
        "elevation_summary": elevation.get("summary") or {},
        "warnings": item.get("warnings") or [],
        "strava_segments": [
            {key: value for key, value in segment.items() if key != "geometry"}
            for segment in item.get("strava_segments") or [] if isinstance(segment, dict)
        ],
        "segment_evidence": item.get("segment_evidence") or {},
        "candidate_kind": item.get("candidate_kind") or "baseline",
        "parent_candidate_id": item.get("parent_candidate_id"),
        "rationale": item.get("rationale"),
    }
    if id_key == "stage_id":
        result.update({
            "day": item.get("day"),
            "period": item.get("period"),
            "handoff_from_previous_km": item.get("handoff_from_previous_km"),
        })
    return result


def route_candidate(
    candidate: dict[str, Any],
    *,
    index: int,
    country_code: str,
    include_elevation: bool,
    config: dict[str, Any],
) -> dict[str, Any]:
    waypoint_queries, is_closed = normalize_waypoint_queries(candidate.get("waypoints") or [])
    queries = waypoint_queries[:-1] if is_closed else waypoint_queries
    if len(queries) < 2:
        raise ValueError("each candidate requires at least two distinct waypoint queries")
    target = _optional_float(candidate.get("target_distance_km"))
    if country_code == "CN":
        places, route = _route_amap(queries, is_closed, config)
    else:
        places, route = _route_google(
            queries, country_code, is_closed, config,
            target_distance_km=target,
        )
    if is_closed:
        places = [*places, dict(places[0])]
    geometry = route["geometry"]
    distance_km = round(float(route.get("distance_m") or 0) / 1000, 1)
    if target is not None:
        minimum_km = target * MIN_TARGET_DISTANCE_RATIO
        maximum_km = target * MAX_TARGET_DISTANCE_RATIO
        if not minimum_km <= distance_km <= maximum_km:
            raise RouteCandidateRejected(
                f"实际 {distance_km:.1f} km，目标 {target:.1f} km，"
                f"允许范围 {minimum_km:.1f}-{maximum_km:.1f} km"
            )
    warnings = list(route.get("warnings") or [])
    if route.get("warning"):
        warnings.append(str(route["warning"]))
    elevation = None
    if include_elevation:
        try:
            elevation = _elevation_profile(geometry["coordinates"], float(route.get("distance_m") or 0), config)
        except (RuntimeError, ValueError) as exc:
            warnings.append(f"海拔请求失败：{exc}")
    return {
        "candidate_id": str(candidate.get("candidate_id") or f"candidate_{index}"),
        "name": str(candidate.get("name") or f"候选路线 {index}"),
        # Compatibility field for existing persistence/UI readers. Closure is
        # derived from waypoint structure and this field is never model-owned.
        "route_type": "loop" if is_closed else "point_to_point",
        "is_closed": is_closed,
        "waypoint_queries": waypoint_queries,
        "waypoints": places,
        "provider": route.get("provider"),
        "travel_mode": route.get("travel_mode") or route.get("profile"),
        "distance_m": float(route.get("distance_m") or 0),
        "distance_km": distance_km,
        "duration_s": float(route.get("duration_s") or 0),
        "duration_min": round(float(route.get("duration_s") or 0) / 60),
        "target_distance_km": target,
        "distance_delta_km": round(distance_km - target, 1) if target is not None else None,
        "geometry": geometry,
        "elevation": elevation,
        "warnings": warnings,
    }


def _route_amap(
    queries: list[str],
    is_closed: bool,
    config: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    amap = config.get("amap") if isinstance(config.get("amap"), dict) else {}
    key = str(amap.get("web_service_key") or "")
    if not key:
        raise ValueError("amap.web_service_key is not configured")
    places: list[dict[str, Any]] = []
    for query in queries:
        anchor = places[-1] if places else None
        region = str((places[0] if places else {}).get("adcode") or "")
        places.append(_search_amap_place(query, key, anchor=anchor, region=region))
    points = [AmapPoint(place["latitude"], place["longitude"]) for place in places]
    if is_closed:
        points.append(points[0])
    route = AmapCyclingRouter(key).route_points(points)
    display_coordinates = [list(gcj02_to_wgs84(lon, lat)) for lon, lat in route["geometry"]]
    return places, {
        **route,
        "travel_mode": "BICYCLE",
        "geometry": {"type": "LineString", "coordinates": display_coordinates},
    }


def _route_google(
    queries: list[str],
    country_code: str,
    is_closed: bool,
    config: dict[str, Any],
    *,
    target_distance_km: float | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    google = config.get("google") if isinstance(config.get("google"), dict) else {}
    key = str(google.get("api_key") or "")
    if not key:
        raise ValueError("google.api_key is not configured")
    client = GooglePlacesClient(key)
    places: list[dict[str, Any]] = []
    # The caller validates the final routed distance. This local search radius
    # prevents an ambiguous place name from escaping to another prefecture
    # before the expensive route request is made.
    target = target_distance_km if is_closed else None
    maximum_radius_km = (
        max(MIN_LOOP_WAYPOINT_RADIUS_KM, target * LOOP_WAYPOINT_RADIUS_RATIO)
        if target is not None else None
    )
    for query in queries:
        anchor = places[0] if places else None
        near = (
            (float(anchor["latitude"]), float(anchor["longitude"]))
            if anchor is not None and maximum_radius_km is not None else None
        )
        search_radius_m = min(
            MAX_GOOGLE_PLACE_BIAS_RADIUS_M,
            maximum_radius_km * 1_000 if maximum_radius_km is not None else 20_000,
        )
        results = client.search(query, near=near, radius_m=search_radius_m, limit=5).get("places") or []
        if not results:
            raise RuntimeError(f"地点检索没有结果：{query}")
        raw = _select_google_place(results, query=query, country_code=country_code, anchor=anchor)
        location = raw["location"]
        place = {
            "query": query,
            "name": raw.get("name") or query,
            "address": raw.get("address") or "",
            "latitude": float(location["latitude"]),
            "longitude": float(location["longitude"]),
        }
        if anchor is not None and maximum_radius_km is not None:
            distance_km = _haversine_km(
                float(anchor["latitude"]), float(anchor["longitude"]),
                place["latitude"], place["longitude"],
            )
            if distance_km > maximum_radius_km:
                raise RouteCandidateRejected(
                    f"地点“{query}”解析为“{place['name']}”，距起点 {distance_km:.1f} km，"
                    f"超过环线途经点上限 {maximum_radius_km:.1f} km"
                )
        places.append(place)
    points = [WgsPoint(place["latitude"], place["longitude"]) for place in places]
    if is_closed and points[-1] != points[0]:
        points.append(points[0])
    route = GoogleRoutesClient(key).route(points, country_code=country_code)
    return places, route


def _select_google_place(
    results: Sequence[dict[str, Any]],
    *,
    query: str,
    country_code: str,
    anchor: dict[str, Any] | None,
) -> dict[str, Any]:
    matching_country = [
        item for item in results
        if not item.get("country_code") or str(item.get("country_code")).upper() == country_code
    ]
    if not matching_country:
        resolved_countries = sorted({
            str(item.get("country_code") or "unknown").upper() for item in results
        })
        raise RouteCandidateRejected(
            f"地点检索结果不在目标国家 {country_code}（返回 {', '.join(resolved_countries)}）"
        )
    normalized_query = _normalize_place_name(query)

    def score(item: dict[str, Any]) -> tuple[int, float]:
        name = _normalize_place_name(str(item.get("name") or ""))
        if normalized_query and (normalized_query in name or name in normalized_query):
            match = 3
        else:
            match = 2 if _character_pairs(normalized_query) & _character_pairs(name) else 0
        distance = 0.0 if anchor is None else _haversine_km(
            float(anchor["latitude"]), float(anchor["longitude"]),
            float(item["location"]["latitude"]), float(item["location"]["longitude"]),
        )
        return match, -distance

    return max(matching_country, key=score)


def _haversine_km(first_lat: float, first_lon: float, second_lat: float, second_lon: float) -> float:
    radius_km = 6_371.0088
    lat1, lat2 = math.radians(first_lat), math.radians(second_lat)
    delta_lat = lat2 - lat1
    delta_lon = math.radians(second_lon - first_lon)
    value = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    return radius_km * 2 * math.atan2(math.sqrt(value), math.sqrt(max(0.0, 1 - value)))


def _search_amap_place(
    query: str,
    key: str,
    *,
    anchor: dict[str, Any] | None = None,
    region: str = "",
) -> dict[str, Any]:
    params: dict[str, Any] = {"key": key, "keywords": query, "page_size": 10}
    endpoint = AMAP_PLACE_TEXT_URL
    if anchor is not None:
        endpoint = AMAP_PLACE_AROUND_URL
        params.update({
            "location": f"{float(anchor['longitude']):.6f},{float(anchor['latitude']):.6f}",
            "radius": 50_000,
            "sortrule": "distance",
        })
        if region:
            params["region"] = region
    elif region:
        params["region"] = region
    payload = _read_json_url(endpoint + "?" + urlencode(params), provider="AMap Places")
    pois = payload.get("pois") or []
    if not pois and anchor is not None:
        fallback = {"key": key, "keywords": query, "page_size": 10}
        if region:
            fallback["region"] = region
        payload = _read_json_url(
            AMAP_PLACE_TEXT_URL + "?" + urlencode(fallback), provider="AMap Places",
        )
        pois = payload.get("pois") or []
    if not pois:
        raise RuntimeError(f"地点检索没有结果：{query}")
    poi = _select_amap_poi(query, pois, anchor=anchor)
    try:
        lon, lat = (float(value) for value in str(poi["location"]).split(",", 1))
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"地点没有可用坐标：{query}") from exc
    wgs_lon, wgs_lat = gcj02_to_wgs84(lon, lat)
    return {
        "query": query,
        "name": str(poi.get("name") or query),
        "address": str(poi.get("address") or ""),
        "latitude": lat,
        "longitude": lon,
        "display_latitude": wgs_lat,
        "display_longitude": wgs_lon,
        "adcode": str(poi.get("adcode") or ""),
        "citycode": str(poi.get("citycode") or ""),
        "place_id": str(poi.get("id") or ""),
    }


def _select_amap_poi(
    query: str, pois: Sequence[dict[str, Any]], *, anchor: dict[str, Any] | None,
) -> dict[str, Any]:
    normalized_query = _normalize_place_name(query)

    def score(poi: dict[str, Any]) -> tuple[int, float]:
        name = _normalize_place_name(str(poi.get("name") or ""))
        if normalized_query and (normalized_query in name or name in normalized_query):
            match = 3
        else:
            query_pairs = _character_pairs(normalized_query)
            name_pairs = _character_pairs(name)
            match = 2 if query_pairs & name_pairs else 0
        distance = _amap_poi_distance_km(poi, anchor)
        return match, -distance

    return max((poi for poi in pois if isinstance(poi, dict)), key=score)


def _normalize_place_name(value: str) -> str:
    return "".join(character.casefold() for character in str(value) if character.isalnum())


def _character_pairs(value: str) -> set[str]:
    return {value[index:index + 2] for index in range(max(0, len(value) - 1))}


def _amap_poi_distance_km(poi: dict[str, Any], anchor: dict[str, Any] | None) -> float:
    if anchor is None:
        return 0.0
    try:
        lon, lat = (float(value) for value in str(poi["location"]).split(",", 1))
        return _haversine_km(
            float(anchor["latitude"]), float(anchor["longitude"]), lat, lon,
        )
    except (KeyError, TypeError, ValueError):
        return float("inf")


def _elevation_profile(
    coordinates: Sequence[Sequence[float]],
    distance_m: float,
    config: dict[str, Any],
    *,
    samples: int = 160,
) -> dict[str, Any]:
    google = config.get("google") if isinstance(config.get("google"), dict) else {}
    key = str(google.get("api_key") or "")
    if not key:
        raise ValueError("google.api_key is not configured")
    path = _resample_line(coordinates, min(samples, 256))
    url = GOOGLE_ELEVATION_URL + "?" + urlencode({
        "path": "enc:" + _encode_polyline(path),
        "samples": samples,
        "key": key,
    })
    payload = _read_json_url(url, provider="Google Elevation")
    if payload.get("status") != "OK":
        raise RuntimeError(str(payload.get("error_message") or payload.get("status") or "provider error"))
    results = payload.get("results") or []
    if len(results) < 2:
        raise RuntimeError("Google Elevation returned too few samples")
    elevations = [float(item["elevation"]) for item in results]
    smoothed = [
        sum(elevations[max(0, index - 1):min(len(elevations), index + 2)])
        / len(elevations[max(0, index - 1):min(len(elevations), index + 2)])
        for index in range(len(elevations))
    ]
    step_m = distance_m / (len(elevations) - 1)
    ascent = sum(max(0.0, second - first) for first, second in zip(smoothed, smoothed[1:]))
    descent = sum(max(0.0, first - second) for first, second in zip(smoothed, smoothed[1:]))
    span = max(1, round(1_000 / max(step_m, 1)))
    grades = [
        (elevations[index + span] - elevations[index]) / (span * step_m) * 100
        for index in range(len(elevations) - span)
    ]
    return {
        "kind": "route_elevation",
        "summary": {
            "samples": len(elevations),
            "sample_spacing_m": round(step_m),
            "minimum_m": round(min(elevations)),
            "maximum_m": round(max(elevations)),
            "ascent_m": round(ascent),
            "descent_m": round(descent),
            "maximum_uphill_percent": round(max(grades), 1),
            "maximum_downhill_percent": round(min(grades), 1),
            "grade_window_m": round(span * step_m),
        },
        "labels": [round(distance_m * index / (len(elevations) - 1) / 1000, 1) for index in range(len(elevations))],
        "elevations_m": [round(value, 1) for value in elevations],
    }


def _read_json_url(url: str, *, provider: str) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(3):
        for proxy_handler in (ProxyHandler(), ProxyHandler({})):
            try:
                with build_opener(proxy_handler).open(url, timeout=25) as response:
                    value = json.load(response)
                if not isinstance(value, dict):
                    raise RuntimeError(f"{provider} returned invalid JSON")
                return value
            except (OSError, TimeoutError, URLError) as exc:
                last_error = exc
        time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"{provider} request failed: {last_error.__class__.__name__ if last_error else 'unknown'}")


def _resample_line(coordinates: Sequence[Sequence[float]], count: int) -> list[tuple[float, float]]:
    points = [(float(item[0]), float(item[1])) for item in coordinates if len(item) >= 2]
    if len(points) < 2:
        raise ValueError("route geometry requires at least two coordinates")
    cumulative = [0.0]
    for first, second in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + _distance_m(first, second))
    targets = [cumulative[-1] * index / (count - 1) for index in range(count)]
    sampled = []
    segment = 0
    for target in targets:
        while segment + 1 < len(cumulative) and cumulative[segment + 1] < target:
            segment += 1
        if segment + 1 >= len(points):
            sampled.append(points[-1])
            continue
        length = cumulative[segment + 1] - cumulative[segment]
        ratio = 0.0 if length == 0 else (target - cumulative[segment]) / length
        sampled.append((
            points[segment][0] + (points[segment + 1][0] - points[segment][0]) * ratio,
            points[segment][1] + (points[segment + 1][1] - points[segment][1]) * ratio,
        ))
    return sampled


def _encode_polyline(points: Sequence[tuple[float, float]]) -> str:
    output: list[str] = []
    previous_lat = previous_lon = 0
    for lon, lat in points:
        current_lat, current_lon = round(lat * 1e5), round(lon * 1e5)
        for delta in (current_lat - previous_lat, current_lon - previous_lon):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                output.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            output.append(chr(value + 63))
        previous_lat, previous_lon = current_lat, current_lon
    return "".join(output)


def _distance_m(first: tuple[float, float], second: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, first)
    lon2, lat2 = map(math.radians, second)
    delta_lon, delta_lat = lon2 - lon1, lat2 - lat1
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6_371_008.8 * 2 * math.asin(math.sqrt(value))


def _optional_float(value: Any) -> float | None:
    if value in {None, ""}:
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("target_distance_km must be numeric") from exc
