"""Segment-aware domestic route planning built on verified baseline routes."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable, Sequence
from uuid import uuid4

from demo.gaode_cycling_router.amap import AmapCyclingRouter, AmapPoint
from demo.gaode_cycling_router.coordinates import gcj02_to_wgs84, wgs84_to_gcj02
from demo.global_cycling_router.google_routes import GoogleRoutesClient, WgsPoint
from demo.osm_cycling_router.segment_loop import haversine_m
from demo.osm_cycling_router.strava_segments import segment_detail_feature
from services.route.segments import enrich_route_plan_with_segments
from services.route.single_day import normalize_waypoint_queries, reverse_waypoint_queries


Explorer = Callable[[str, str], dict[str, Any]]
DetailFetcher = Callable[[int], dict[str, Any]]
Selector = Callable[[dict[str, Any]], dict[str, Any]]
ElevationBuilder = Callable[[Sequence[Sequence[float]], float], dict[str, Any]]
ConnectorRouter = Callable[[Sequence[float], Sequence[float]], dict[str, Any]]


def apply_segment_aware_routing(
    plan: dict[str, Any],
    *,
    strategy: str,
    access_token: str,
    amap_key: str = "",
    google_key: str = "",
    connector_router: ConnectorRouter | None = None,
    request_text: str,
    preferences: Sequence[str] = (),
    include_elevation: bool = True,
    corridor_km: float = 5.0,
    max_segments_per_target: int = 10,
    explorer: Explorer,
    detail_fetcher: DetailFetcher,
    selector: Selector,
    elevation_builder: ElevationBuilder | None = None,
    preserve_baseline: bool = False,
    max_proposals: int = 2,
) -> dict[str, Any]:
    """Enrich and optionally replace each baseline target with a Segment route.

    Explicit waypoints stay as hard anchors. Strava Segments are route material
    between those anchors; the country-specific map provider validates every
    connector. ``auto`` falls back to the baseline target, while ``require``
    refuses an unverified target.
    """
    normalized_strategy = str(strategy or "auto").strip().lower()
    if normalized_strategy not in {"auto", "ignore", "require"}:
        raise ValueError("segment_strategy must be auto, ignore or require")
    updated = deepcopy(plan)
    updated["segment_strategy"] = normalized_strategy
    updated["segment_preferences"] = [str(value) for value in preferences if str(value).strip()]
    if normalized_strategy == "ignore":
        return _add_final_elevation(updated, include_elevation, elevation_builder)
    country_code = str(updated.get("country_code") or "").upper()
    router = connector_router or build_connector_router(
        country_code=country_code,
        amap_key=amap_key,
        google_key=google_key,
    )

    targets = _plan_targets(updated)
    available: dict[str, list[dict[str, Any]]] = {}
    selection_targets = []
    for target_id, target in targets:
        temporary = {
            "plan_id": "segment_discovery",
            "workspace_id": "segment_discovery",
            "active_candidate_id": target_id,
            "candidates": [{**deepcopy(target), "candidate_id": target_id}],
        }
        discovered_plan, discovery = enrich_route_plan_with_segments(
            temporary,
            access_token=access_token,
            candidate_id=target_id,
            corridor_km=corridor_km,
            max_segments=max_segments_per_target,
            explorer=explorer,
        )
        segments = discovered_plan["candidates"][0].get("strava_segments") or []
        available[target_id] = segments
        target["strava_segment_discovery"] = {
            "source": "strava_segments_explore",
            "corridor_km": corridor_km,
            "sample_count": sum(int(item.get("sample_count") or 0) for item in discovery.get("targets") or []),
            "nearby_segment_count": len(segments),
            "discovery_limit": discovery.get("discovery_limit"),
        }
        selection_targets.append({
            "target_id": target_id,
            "label": target.get("label") or target.get("name") or target_id,
            "route_type": target.get("route_type"),
            "is_closed": bool(target.get("is_closed") or target.get("route_type") == "loop"),
            "target_distance_km": target.get("target_distance_km"),
            "baseline_distance_km": target.get("distance_km"),
            "anchors": [
                point.get("query") or point.get("name")
                for point in target.get("waypoints") or [] if isinstance(point, dict)
            ],
            "segments": [
                {key: value for key, value in segment.items() if key != "geometry"}
                for segment in segments
            ],
        })

    updated["segment_pool"] = {
        target_id: [deepcopy(segment) for segment in segments]
        for target_id, segments in available.items()
    }
    package = {
        "schema_version": "route_segment_selection_request.v1",
        "request": request_text,
        "preferences": updated["segment_preferences"],
        "rules": {
            "anchors_are_hard_constraints": True,
            "maximum_proposals_per_target": max(1, min(2, int(max_proposals))),
            "maximum_segments_per_proposal": 2,
            "do_not_invent_segment_ids": True,
        },
        "targets": selection_targets,
    }
    try:
        proposals = _proposal_map(selector(package), available)
    except Exception as exc:  # noqa: BLE001 - auto mode explicitly degrades to the verified baseline
        if normalized_strategy == "require":
            raise RuntimeError(f"Strava route selection failed: {exc}") from exc
        proposals = (
            _deterministic_proposals(available, max_proposals=max_proposals)
            if preserve_baseline else {}
        )
        for _, target in targets:
            if proposals.get(str(target.get("candidate_id") or target.get("stage_id") or "")):
                _append_warning(
                    target,
                    f"Strava 智能筛选不可用，已用真实路段排序生成候选：{type(exc).__name__}",
                )
            else:
                _append_warning(target, f"Strava 路段选择失败，保留地图基准路线：{type(exc).__name__}")

    composed_count = 0
    proposed_candidates: list[dict[str, Any]] = []
    for target_id, target in targets:
        target_proposals = proposals.get(target_id) or []
        if not target_proposals:
            if normalized_strategy == "require":
                raise RuntimeError(f"Strava did not produce a usable selection for {target_id}")
            _append_warning(target, "未选择到适合当前锚点顺序的 Strava 路段，保留地图基准路线")
            continue
        successful: list[dict[str, Any]] = []
        for proposal_index, proposal in enumerate(target_proposals[:max_proposals], start=1):
            try:
                selected = _selected_segments(
                    proposal["segments"], available.get(target_id) or [], detail_fetcher,
                )
                composed = _compose_target(target, selected, router=router)
                # An automatically selected Segment must never turn a bounded
                # map baseline into an implausibly long connector route. This
                # applies whether the enhanced result replaces the baseline or
                # is shown beside it.
                _validate_automatic_candidate(target, composed)
                if preserve_baseline:
                    composed.update({
                        "candidate_id": f"{target_id}_segment_{proposal_index}",
                        "candidate_kind": "segment_variant",
                        "parent_candidate_id": target_id,
                        "name": str(proposal.get("name") or f"{target.get('name') or '路线'} · Strava {proposal_index}"),
                        "rationale": str(proposal.get("reason") or "包含真实 Strava 热门路段"),
                    })
                successful.append(composed)
            except Exception as exc:  # noqa: BLE001 - invalid proposals never replace the provider baseline
                if normalized_strategy == "require" and not preserve_baseline:
                    raise RuntimeError(f"Strava route composition failed for {target_id}: {exc}") from exc
                _append_warning(target, f"一个 Strava 候选未通过真实算路校验：{type(exc).__name__}")
        if preserve_baseline:
            target["candidate_kind"] = target.get("candidate_kind") or "baseline"
            proposed_candidates.extend(successful)
            composed_count += int(bool(successful))
        elif successful:
            target.clear()
            target.update(successful[0])
            composed_count += 1
        elif normalized_strategy == "require":
            raise RuntimeError(f"Strava did not produce a usable selection for {target_id}")

    if preserve_baseline:
        if any(isinstance(candidate.get("stages"), list) for candidate in updated.get("candidates") or []):
            raise ValueError("proposal mode currently supports single-day candidates only")
        updated["candidates"] = [
            *[candidate for candidate in updated.get("candidates") or [] if isinstance(candidate, dict)],
            *proposed_candidates,
        ][:3]
        updated["planning"] = {
            **(updated.get("planning") if isinstance(updated.get("planning"), dict) else {}),
            "status": "awaiting_selection",
            "confirmed_candidate_id": None,
            "include_elevation": bool(include_elevation),
        }

    updated["segment_aware_summary"] = {
        "target_count": len(targets),
        "composed_target_count": composed_count,
        "fallback_target_count": len(targets) - composed_count,
        "proposed_candidate_count": len(proposed_candidates) if preserve_baseline else composed_count,
    }
    if preserve_baseline:
        return updated
    return _add_final_elevation(updated, include_elevation, elevation_builder)


def _plan_targets(plan: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    targets = []
    for candidate in plan.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        stages = [item for item in candidate.get("stages") or [] if isinstance(item, dict)]
        if stages:
            targets.extend((str(stage.get("stage_id") or ""), stage) for stage in stages)
        else:
            targets.append((str(candidate.get("candidate_id") or ""), candidate))
    return [(identifier, target) for identifier, target in targets if identifier]


def _proposal_map(
    payload: Any,
    available: dict[str, list[dict[str, Any]]],
) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(payload, dict):
        raise ValueError("route selector must return an object")
    raw_proposals = payload.get("proposals")
    if not isinstance(raw_proposals, list):
        # Backwards-compatible shape used by older clients and deterministic tests.
        raw_proposals = payload.get("selections") or []
    result: dict[str, list[dict[str, Any]]] = {}
    for selection in raw_proposals:
        if not isinstance(selection, dict):
            continue
        target_id = str(selection.get("target_id") or "")
        if len(result.get(target_id) or []) >= 2:
            continue
        valid_ids = {int(item["segment_id"]) for item in available.get(target_id) or []}
        choices = []
        for item in selection.get("segments") or []:
            if not isinstance(item, dict):
                continue
            try:
                segment_id = int(item.get("segment_id"))
            except (TypeError, ValueError):
                continue
            direction = str(item.get("direction") or "forward").lower()
            if segment_id in valid_ids and direction in {"auto", "forward", "reverse"}:
                choices.append({"segment_id": segment_id, "direction": direction})
            if len(choices) >= 2:
                break
        if choices:
            result.setdefault(target_id, []).append({
                "name": str(selection.get("name") or ""),
                "reason": str(selection.get("reason") or ""),
                "segments": choices,
            })
    return result


def _deterministic_proposals(
    available: dict[str, list[dict[str, Any]]], *, max_proposals: int,
) -> dict[str, list[dict[str, Any]]]:
    """Build bounded alternatives from discovered IDs when selector output is unusable.

    Discovery already ranks Segments by overlap and distance to the baseline.
    Keeping one real Segment per fallback proposal avoids guessing combinations;
    normal connector and distance validation still decides whether it is shown.
    """
    limit = max(1, min(2, int(max_proposals)))
    result: dict[str, list[dict[str, Any]]] = {}
    for target_id, segments in available.items():
        proposals = []
        for segment in segments[:limit]:
            try:
                segment_id = int(segment["segment_id"])
            except (KeyError, TypeError, ValueError):
                continue
            proposals.append({
                "name": f"经过 {segment.get('name') or f'Strava Segment {segment_id}'}",
                "reason": "智能筛选输出不可用，按与基准路线的重合度和距离生成",
                "segments": [{
                    "segment_id": segment_id,
                    "direction": str(segment.get("suggested_direction") or "forward"),
                }],
            })
        if proposals:
            result[target_id] = proposals
    return result


def _selection_map(
    payload: Any,
    available: dict[str, list[dict[str, Any]]],
) -> dict[str, list[dict[str, Any]]]:
    """Compatibility view returning the first proposal for each target."""
    proposals = _proposal_map(payload, available)
    return {
        target_id: values[0]["segments"]
        for target_id, values in proposals.items() if values
    }


def _selected_segments(
    choices: Sequence[dict[str, Any]],
    available: Sequence[dict[str, Any]],
    detail_fetcher: DetailFetcher,
) -> list[dict[str, Any]]:
    by_id = {int(item["segment_id"]): item for item in available}
    selected = []
    for choice in choices:
        segment_id = int(choice["segment_id"])
        summary = by_id.get(segment_id)
        if not summary:
            raise ValueError(f"Strava Segment {segment_id} is not in the discovered pool")
        try:
            feature = segment_detail_feature(detail_fetcher(segment_id))
        except Exception:  # Explorer geometry is a bounded fallback when detail temporarily fails.
            feature = _summary_feature(summary)
        direction = str(choice.get("direction") or "auto").lower()
        if direction == "auto":
            direction = str(summary.get("suggested_direction") or "forward")
        selected.append({"summary": summary, "feature": feature, "direction": direction})
    if not selected:
        raise ValueError("at least one discovered Strava Segment is required")
    return selected


def _validate_automatic_candidate(baseline: dict[str, Any], candidate: dict[str, Any]) -> None:
    baseline_distance = float(baseline.get("distance_m") or 0)
    distance = float(candidate.get("distance_m") or 0)
    target = baseline.get("target_distance_km")
    if target is not None:
        tolerance_km = max(5.0, float(target) * 0.30)
        if abs(distance / 1000 - float(target)) > tolerance_km:
            raise RuntimeError("Strava candidate is too far from the requested distance")
    elif baseline_distance > 0 and distance / baseline_distance > 1.5:
        raise RuntimeError("Strava candidate is more than 1.5x the baseline route")
    connector_ratio = float((candidate.get("segment_evidence") or {}).get("connector_ratio") or 0)
    if connector_ratio > 0.75:
        raise RuntimeError("Strava candidate requires too much connector distance")


def compose_route_with_segments(
    plan: dict[str, Any],
    *,
    candidate_id: str | None,
    segments: Sequence[dict[str, Any]],
    amap_key: str = "",
    google_key: str = "",
    connector_router: ConnectorRouter | None = None,
    detail_fetcher: DetailFetcher,
    target_distance_km: float | None = None,
    name: str = "",
) -> dict[str, Any]:
    """Create a new draft candidate from explicit, already-discovered Segment IDs."""
    updated = deepcopy(plan)
    candidates = [item for item in updated.get("candidates") or [] if isinstance(item, dict)]
    selected_id = str(candidate_id or updated.get("active_candidate_id") or "")
    selected_candidate = next(
        (item for item in candidates if str(item.get("candidate_id") or "") == selected_id), None,
    )
    if selected_candidate is None:
        raise ValueError("route candidate does not exist")
    baseline_id = str(selected_candidate.get("parent_candidate_id") or selected_candidate.get("candidate_id") or "")
    baseline = next(
        (item for item in candidates if str(item.get("candidate_id") or "") == baseline_id), selected_candidate,
    )
    pools = updated.get("segment_pool") if isinstance(updated.get("segment_pool"), dict) else {}
    available = pools.get(baseline_id) if isinstance(pools.get(baseline_id), list) else []
    if not available:
        raise ValueError("当前路线没有可复用的 Strava 路段池，请先查询附近路段")
    choices = []
    for item in segments:
        if not isinstance(item, dict):
            continue
        choices.append({
            "segment_id": item.get("segment_id"),
            "direction": str(item.get("direction") or "auto"),
        })
    selected = _selected_segments(choices, available, detail_fetcher)
    composition_base = dict(baseline)
    if target_distance_km is not None:
        composition_base["target_distance_km"] = float(target_distance_km)
    composed = _compose_target(
        composition_base,
        selected,
        router=connector_router or build_connector_router(
            country_code=str(updated.get("country_code") or "").upper(),
            amap_key=amap_key,
            google_key=google_key,
        ),
        preserve_segment_order=True,
    )
    baseline_distance = float(baseline.get("distance_m") or 0)
    distance_ratio = float(composed.get("distance_m") or 0) / max(1.0, baseline_distance)
    if distance_ratio > 1.5:
        _append_warning(composed, f"用户指定路段使路线达到基础路线的 {distance_ratio:.1f} 倍，请确认距离是否可接受")
    if target_distance_km is not None:
        delta = abs(float(composed.get("distance_km") or 0) - float(target_distance_km))
        if delta > max(5.0, float(target_distance_km) * 0.30):
            _append_warning(composed, f"用户指定路段组合与目标距离相差 {delta:.1f} km，请确认是否接受")
    custom_id = f"candidate_custom_{uuid4().hex[:8]}"
    composed.update({
        "candidate_id": custom_id,
        "candidate_kind": "segment_custom",
        "parent_candidate_id": baseline_id,
        "name": str(name or "自选 Strava 路段路线"),
        "rationale": "按用户指定的 Strava 路段顺序生成",
    })
    retained = [
        item for item in candidates
        if str(item.get("candidate_id") or "") != selected_id or selected_id == baseline_id
    ]
    if len(retained) >= 3:
        retained = [item for item in retained if item.get("candidate_kind") == "baseline"][:1] + retained[-1:]
    updated["candidates"] = [*retained, composed][:3]
    updated["active_candidate_id"] = custom_id
    updated["planning"] = {
        **(updated.get("planning") if isinstance(updated.get("planning"), dict) else {}),
        "status": "awaiting_selection",
        "confirmed_candidate_id": None,
        "segment_constraints": {
            "required": [
                {"segment_id": int(item["summary"]["segment_id"]), "direction": item["direction"], "order": index}
                for index, item in enumerate(selected, start=1)
            ],
        },
    }
    return updated


def reverse_segment_candidate(
    plan: dict[str, Any], *, candidate_id: str | None = None,
) -> dict[str, Any]:
    """Reverse a composed Segment route without rediscovery or provider rerouting."""
    updated = deepcopy(plan)
    candidates = [item for item in updated.get("candidates") or [] if isinstance(item, dict)]
    selected_id = str(candidate_id or updated.get("active_candidate_id") or "")
    selected = next(
        (item for item in candidates if str(item.get("candidate_id") or "") == selected_id), None,
    )
    if selected is None:
        raise ValueError("route candidate does not exist")
    coordinates = _coordinates(selected.get("geometry"))
    queries = [str(value) for value in selected.get("waypoint_queries") or []]
    waypoints = [dict(value) for value in selected.get("waypoints") or [] if isinstance(value, dict)]
    normalized_queries, query_closed = normalize_waypoint_queries(queries)
    waypoint_closed = len(waypoints) > 1 and waypoints[0] == waypoints[-1]
    geometry_closed = (
        len(coordinates) > 1
        and haversine_m(coordinates[0], coordinates[-1]) <= 20.0
    )
    is_closed = bool(selected.get("is_closed") or query_closed or waypoint_closed or geometry_closed)
    if is_closed:
        if normalized_queries and not query_closed:
            normalized_queries.append(normalized_queries[0])
        reversed_queries = reverse_waypoint_queries(normalized_queries) if normalized_queries else []
        core = waypoints[:-1] if len(waypoints) > 1 and waypoints[0] == waypoints[-1] else waypoints
        reversed_core = [core[0], *reversed(core[1:])] if core else []
        reversed_waypoints = [*reversed_core, dict(reversed_core[0])] if reversed_core else []
    else:
        reversed_queries = reverse_waypoint_queries(normalized_queries)
        reversed_waypoints = list(reversed(waypoints))
    reversed_segments = []
    for segment in reversed([item for item in selected.get("strava_segments") or [] if isinstance(item, dict)]):
        geometry = segment.get("geometry") if isinstance(segment.get("geometry"), dict) else {}
        segment_coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
        direction = str(segment.get("direction") or "forward")
        reversed_segments.append({
            **segment,
            "direction": "reverse" if direction != "reverse" else "forward",
            "geometry": {**geometry, "coordinates": list(reversed(segment_coordinates))},
        })
    elevation = selected.get("elevation") if isinstance(selected.get("elevation"), dict) else None
    if elevation and isinstance(elevation.get("elevations_m"), list):
        elevation = {**elevation, "elevations_m": list(reversed(elevation["elevations_m"]))}
    evidence = dict(selected.get("segment_evidence") or {})
    if isinstance(evidence.get("segment_ids"), list):
        evidence["segment_ids"] = list(reversed(evidence["segment_ids"]))
    reversed_candidate = {
        **selected,
        "is_closed": is_closed,
        "route_type": "loop" if is_closed else "point_to_point",
        "waypoint_queries": reversed_queries,
        "waypoints": reversed_waypoints,
        "geometry": {"type": "LineString", "coordinates": list(reversed(coordinates))},
        "strava_segments": reversed_segments,
        "segment_evidence": evidence,
        "elevation": elevation,
        "warnings": [*(selected.get("warnings") or []), "已反转完整路线、Strava 路段顺序和方向。"],
    }
    updated["candidates"] = [
        reversed_candidate if item is selected else item for item in candidates
    ]
    updated["planning"] = {
        **(updated.get("planning") if isinstance(updated.get("planning"), dict) else {}),
        "status": "awaiting_selection",
        "confirmed_candidate_id": None,
    }
    return updated


def _compose_target(
    baseline: dict[str, Any],
    selected: list[dict[str, Any]],
    *,
    router: ConnectorRouter,
    preserve_segment_order: bool = False,
) -> dict[str, Any]:
    if not selected:
        raise ValueError("at least one selected segment is required")
    baseline_geometry = _coordinates(baseline.get("geometry"))
    anchors = _anchor_events(baseline, baseline_geometry)
    events: list[tuple[float, int, str, Any]] = []
    if not preserve_segment_order:
        events.extend((ratio, 1, "anchor", point) for ratio, point in anchors[1:])
    persisted_segments = []
    for item in selected:
        summary = item["summary"]
        feature = item["feature"]
        coordinates = _coordinates(feature.get("geometry"))
        direction = item["direction"]
        if direction == "reverse":
            coordinates = list(reversed(coordinates))
        position = (
            float(len(events))
            if preserve_segment_order
            else float(summary.get("route_position_ratio") or 0)
        )
        events.append((position, 0, "segment", coordinates))
        properties = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        persisted_segments.append({
            **{key: value for key, value in summary.items() if key != "geometry"},
            "direction": direction,
            "distance_km": round(float(properties.get("distance_m") or summary.get("distance_km", 0) * 1000) / 1000, 2),
            "geometry": {"type": "LineString", "coordinates": coordinates},
        })
    if preserve_segment_order:
        events.append((float(len(events)), 1, "anchor", anchors[-1][1]))
    else:
        events.sort(key=lambda item: (item[0], item[1]))

    geometry: list[list[float]] = []
    connector_distance_m = connector_duration_s = segment_distance_m = 0.0
    current = anchors[0][1]

    def append(points: Sequence[Sequence[float]]) -> None:
        for point in points:
            normalized = [float(point[0]), float(point[1])]
            if not geometry or geometry[-1] != normalized:
                geometry.append(normalized)

    append([current])
    for _, _, kind, value in events:
        destination = value[0] if kind == "segment" else value
        connector = _connector(current, destination, router)
        append(connector["coordinates"])
        connector_distance_m += connector["distance_m"]
        connector_duration_s += connector["duration_s"]
        if kind == "segment":
            append(value)
            distance = _line_distance_m(value)
            segment_distance_m += distance
            current = value[-1]
        else:
            current = value

    distance_m = connector_distance_m + segment_distance_m
    baseline_distance = float(baseline.get("distance_m") or 0)
    baseline_duration = float(baseline.get("duration_s") or 0)
    speed_mps = baseline_distance / baseline_duration if baseline_distance > 0 and baseline_duration > 0 else 5.0
    duration_s = connector_duration_s + segment_distance_m / max(2.5, speed_mps)
    connector_ratio = connector_distance_m / max(1.0, distance_m)
    if connector_ratio > 0.9:
        raise ValueError("selected segments require too much connector distance")
    warnings = [
        warning for warning in baseline.get("warnings") or []
        if not str(warning).startswith((
            "未选择到适合", "Strava 路段选择失败", "一个 Strava 候选未通过",
        ))
    ]
    warnings.extend([
        "路线包含 Strava 热门路段，路段之间由地图服务连接",
        "Strava 路段上的预计时间按地图基准路线平均速度估算",
    ])
    distance_km = round(distance_m / 1000, 1)
    target_distance = baseline.get("target_distance_km")
    return {
        **baseline,
        "name": str(baseline.get("name") or baseline.get("label") or "路线"),
        "provider": f"{baseline.get('provider') or 'map'}+strava",
        "travel_mode": baseline.get("travel_mode") or "BICYCLE",
        "distance_m": distance_m,
        "distance_km": distance_km,
        "duration_s": duration_s,
        "duration_min": round(duration_s / 60),
        "distance_delta_km": round(distance_km - float(target_distance), 1) if target_distance is not None else None,
        "geometry": {"type": "LineString", "coordinates": geometry},
        "elevation": None,
        "strava_segments": persisted_segments,
        "segment_evidence": {
            "segment_ids": [int(item["segment_id"]) for item in persisted_segments],
            "connector_distance_km": round(connector_distance_m / 1000, 2),
            "connector_ratio": round(connector_ratio, 3),
            "baseline_distance_km": baseline.get("distance_km"),
        },
        "warnings": warnings,
    }


def _anchor_events(target: dict[str, Any], route: Sequence[Sequence[float]]) -> list[tuple[float, list[float]]]:
    anchors = []
    for point in target.get("waypoints") or []:
        if not isinstance(point, dict):
            continue
        lat = point.get("display_latitude", point.get("latitude"))
        lon = point.get("display_longitude", point.get("longitude"))
        try:
            anchors.append([float(lon), float(lat)])
        except (TypeError, ValueError):
            continue
    if len(anchors) < 2:
        raise ValueError("baseline route has insufficient anchors")
    events = [(0.0, anchors[0])]
    previous_index = 0
    for ordinal, anchor in enumerate(anchors[1:], start=1):
        if ordinal == len(anchors) - 1:
            index = len(route) - 1
        else:
            index = min(
                range(previous_index, len(route)),
                key=lambda candidate: haversine_m(anchor, route[candidate]),
            )
        events.append((index / max(1, len(route) - 1), anchor))
        previous_index = index
    return events


def _connector(
    origin: Sequence[float],
    destination: Sequence[float],
    router: ConnectorRouter,
) -> dict[str, Any]:
    straight = haversine_m(origin, destination)
    if straight <= 30:
        return {"coordinates": [list(origin), list(destination)], "distance_m": straight, "duration_s": 0.0}
    routed = router(origin, destination)
    geometry = routed.get("geometry") if isinstance(routed.get("geometry"), dict) else {}
    coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
    if len(coordinates) < 2:
        raise ValueError("map connector returned no usable geometry")
    return {
        "coordinates": [list(point) for point in coordinates],
        "distance_m": float(routed.get("distance_m") or 0),
        "duration_s": float(routed.get("duration_s") or 0),
    }


def build_connector_router(
    *, country_code: str, amap_key: str = "", google_key: str = "",
) -> ConnectorRouter:
    """Return one WGS-84 connector independent of the composition algorithm."""
    if str(country_code or "").upper() == "CN":
        if not amap_key:
            raise ValueError("amap.web_service_key is not configured")
        amap_router = AmapCyclingRouter(amap_key)

        def route_amap(origin: Sequence[float], destination: Sequence[float]) -> dict[str, Any]:
            origin_gcj = wgs84_to_gcj02(float(origin[0]), float(origin[1]))
            destination_gcj = wgs84_to_gcj02(float(destination[0]), float(destination[1]))
            routed = amap_router.route(
                AmapPoint(origin_gcj[1], origin_gcj[0]),
                AmapPoint(destination_gcj[1], destination_gcj[0]),
            )
            return {
                **routed,
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        list(gcj02_to_wgs84(lon, lat)) for lon, lat in routed["geometry"]
                    ],
                },
            }

        return route_amap
    if not google_key:
        raise ValueError("google.api_key is not configured")
    google_router = GoogleRoutesClient(google_key)

    def route_google(origin: Sequence[float], destination: Sequence[float]) -> dict[str, Any]:
        return google_router.route([
            WgsPoint(float(origin[1]), float(origin[0])),
            WgsPoint(float(destination[1]), float(destination[0])),
        ], country_code=str(country_code or "").upper())

    return route_google


def _summary_feature(summary: dict[str, Any]) -> dict[str, Any]:
    geometry = summary.get("geometry") if isinstance(summary.get("geometry"), dict) else {}
    if len(geometry.get("coordinates") or []) < 2:
        raise ValueError("selected Strava Segment has no usable geometry")
    return {
        "type": "Feature",
        "properties": {
            "id": int(summary["segment_id"]),
            "name": summary.get("name"),
            "distance_m": float(summary.get("distance_km") or 0) * 1000,
            "ascend_m": summary.get("elevation_difference_m") or 0,
        },
        "geometry": geometry,
    }


def _coordinates(geometry: Any) -> list[list[float]]:
    value = geometry if isinstance(geometry, dict) else {}
    points = [
        [float(point[0]), float(point[1])]
        for point in value.get("coordinates") or []
        if isinstance(point, (list, tuple)) and len(point) >= 2
    ]
    if value.get("type") != "LineString" or len(points) < 2:
        raise ValueError("route geometry must be a usable LineString")
    return points


def _line_distance_m(points: Sequence[Sequence[float]]) -> float:
    return sum(haversine_m(first, second) for first, second in zip(points, points[1:]))


def _append_warning(target: dict[str, Any], warning: str) -> None:
    target["warnings"] = [*list(target.get("warnings") or []), warning]


def _add_final_elevation(
    plan: dict[str, Any],
    include_elevation: bool,
    elevation_builder: ElevationBuilder | None,
) -> dict[str, Any]:
    if not include_elevation or elevation_builder is None:
        return plan
    for _, target in _plan_targets(plan):
        geometry = _coordinates(target.get("geometry"))
        try:
            target["elevation"] = elevation_builder(geometry, float(target.get("distance_m") or 0))
        except (RuntimeError, ValueError) as exc:
            _append_warning(target, f"海拔请求失败：{exc}")
            target["elevation"] = None
    return plan
