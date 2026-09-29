"""Verified single-day route plans built from the existing map-provider demos."""

from __future__ import annotations

import json
import math
import time
from collections.abc import Iterable, Sequence
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener
from uuid import uuid4
from copy import deepcopy

from integrations.google_places import GooglePlacesClient
from integrations.provider_error import ProviderError, TransientProviderError
from integrations.route_providers.amap import (
    AmapCyclingRouter,
    AmapPoint,
    compose_amap_legs,
    validate_amap_response,
)
from integrations.route_providers.coordinates import gcj02_to_wgs84
from integrations.route_providers.google_routes import GoogleRoutesClient, WgsPoint
from services.route.quality import (
    apply_route_constraints,
    normalize_route_constraints,
    normalize_route_preferences,
    preference_score,
)
from services.route.provider_readiness import ensure_google_route_provider_ready, use_amap_routes
from services.route.distance import target_distance_error
from settings import load_config


AMAP_PLACE_TEXT_URL = "https://restapi.amap.com/v5/place/text"
AMAP_PLACE_AROUND_URL = "https://restapi.amap.com/v5/place/around"
GOOGLE_ELEVATION_URL = "https://maps.googleapis.com/maps/api/elevation/json"
LOOP_WAYPOINT_RADIUS_RATIO = 0.75
MIN_LOOP_WAYPOINT_RADIUS_KM = 5.0
MAX_GOOGLE_PLACE_BIAS_RADIUS_M = 50_000.0


class RouteCandidateRejected(ValueError):
    """A provider-resolved candidate that violates deterministic route bounds."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "route_candidate_rejected",
        stage: str = "route_validation",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.retryable = False

    def to_tool_result(self) -> dict[str, Any]:
        return {
            "status": "failed", "error": self.code, "code": self.code,
            "stage": self.stage, "retryable": self.retryable,
            "message": str(self),
            **({"place_resolution": self.place_resolution} if hasattr(self, "place_resolution") else {}),
            **({"route_search": {
                **self.search_diagnostics,
                "measurements": [{k: v for k, v in row.items() if k != "geometry"}
                                 for row in self.search_diagnostics["measurements"]],
            }} if hasattr(self, "search_diagnostics") else {}),
        }


class RouteProviderFailed(RuntimeError):
    """All candidates failed because an upstream route provider was unavailable."""

    def __init__(self, failures: Sequence[dict[str, Any]], *, candidate_rejections=()) -> None:
        self.failures = [dict(item) for item in failures]
        self.candidate_rejections = [dict(item) for item in candidate_rejections]
        message = _provider_failure_summary(self.failures)
        if self.candidate_rejections:
            message += " 其他候选未满足路线要求：" + "；".join(
                f"{item['name']}：{item['reason']}" for item in self.candidate_rejections
            )
        super().__init__(message)

    def to_tool_result(self) -> dict[str, Any]:
        first = self.failures[0] if self.failures else {}
        providers = sorted({str(item.get("provider") or "unknown") for item in self.failures})
        return {
            "status": "failed",
            "error": "route_provider_error",
            "code": "route_provider_error",
            "provider": ",".join(providers),
            "stage": str(first.get("stage") or "route_planning"),
            "retryable": any(item.get("retryable") is not False for item in self.failures),
            "message": str(self),
            "failures": self.failures,
        }


def _provider_failure_summary(failures: Sequence[dict[str, Any]]) -> str:
    labels = {
        "google": "Google 代理链路",
        "google_places": "Google 地点检索",
        "google_routes": "Google 路线计算",
        "amap": "高德路线服务",
    }
    providers = []
    messages = []
    for failure in failures:
        provider = str(failure.get("provider") or "route_provider")
        label = labels.get(provider, "路线服务")
        if label not in providers:
            providers.append(label)
        message = str(failure.get("message") or "").strip()
        if message and message not in messages:
            messages.append(message)
    provider_text = "、".join(providers) or "路线服务"
    detail = messages[0] if messages else "上游服务未返回可用结果"
    extra = f"；另有 {len(messages) - 1} 类失败" if len(messages) > 1 else ""
    return f"{provider_text}暂时不可用：{detail}{extra}。已保留当前路线，请稍后重试。"


def create_single_day_plan(
    *,
    workspace_id: str,
    title: str,
    country_code: str,
    candidates: Sequence[dict[str, Any]],
    include_elevation: bool = True,
    plan_id: str | None = None,
    route_constraints: dict[str, Any] | None = None,
    route_preferences: dict[str, Any] | None = None,
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
    if not use_amap_routes(normalized_country, config):
        ensure_google_route_provider_ready(config)
    normalized_constraints = normalize_route_constraints(route_constraints)
    normalized_preferences = normalize_route_preferences(route_preferences)
    routed: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    provider_failures: list[dict[str, Any]] = []
    # Only successful resolutions are shared within this planning call. No
    # negative cache survives a candidate failure or application restart.
    google_place_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
    for index, candidate in enumerate(candidates, start=1):
        try:
            routed.append(route_candidate(
                candidate,
                index=index,
                country_code=normalized_country,
                include_elevation=include_elevation,
                config=config,
                route_constraints=normalized_constraints,
                route_preferences=normalized_preferences,
                provider_preflight_completed=True,
                google_place_cache=google_place_cache,
            ))
        except RouteCandidateRejected as exc:
            rejected.append({
                "name": str(candidate.get("name") or f"候选路线 {index}"),
                "reason": str(exc),
                "code": exc.code,
                "stage": exc.stage,
                "retryable": False,
            })
        except ProviderError as exc:
            failure = exc.to_failure()
            failure["name"] = str(candidate.get("name") or f"候选路线 {index}")
            rejected.append({**failure, "reason": str(exc)})
            provider_failures.append(failure)
        except RuntimeError as exc:
            # Compatibility boundary for older adapters and injected test
            # doubles. Production route providers raise ProviderError.
            failure = _classify_provider_failure(exc)
            failure["name"] = str(candidate.get("name") or f"候选路线 {index}")
            rejected.append({**failure, "reason": str(exc)})
            provider_failures.append(failure)
    if not routed:
        if provider_failures:
            raise RouteProviderFailed(provider_failures, candidate_rejections=[
                item for item in rejected if item.get("stage") == "route_validation"
            ])
        reasons = "；".join(f"{item['name']}：{item['reason']}" for item in rejected)
        rejection_codes = {str(item.get("code") or "") for item in rejected}
        rejection_stages = {str(item.get("stage") or "") for item in rejected}
        raise RouteCandidateRejected(
            f"所有路线候选均不可用。{reasons}",
            code=(rejection_codes.pop() if len(rejection_codes) == 1 else "route_candidate_rejected"),
            stage=(rejection_stages.pop() if len(rejection_stages) == 1 else "route_validation"),
        )
    active = _select_active_candidate(routed, normalized_preferences)
    return {
        "schema_version": "route_plan.v1",
        "plan_id": plan_id or f"route_{uuid4().hex}",
        "workspace_id": str(workspace_id),
        "revision": 0,
        "title": str(title or "单日骑行路线"),
        "day_count": 1,
        "country_code": normalized_country,
        "active_candidate_id": active["candidate_id"],
        "candidates": routed,
        "rejected_candidates": rejected,
        "route_constraints": normalized_constraints,
        "route_preferences": normalized_preferences,
    }


def _classify_provider_failure(exc: RuntimeError) -> dict[str, Any]:
    text = str(exc)
    lowered = text.lower()
    if "google places" in lowered:
        provider, stage = "google_places", "place_search"
    elif "google routes" in lowered:
        provider, stage = "google_routes", "route_calculation"
    elif "高德" in text or "amap" in lowered:
        provider, stage = "amap", "route_calculation"
    else:
        provider, stage = "route_provider", "route_planning"
    retryable = any(token in lowered for token in (
        "timeout", "timed out", "connection", "network", "reset", "eof", "temporar",
    ))
    return {
        "code": "provider_unavailable" if retryable else "provider_rejected",
        "provider": provider,
        "stage": stage,
        "retryable": retryable,
        "message": text,
    }


def _select_active_candidate(
    candidates: Sequence[dict[str, Any]],
    route_preferences: dict[str, Any],
) -> dict[str, Any]:
    """Prefer the route nearest the target, then apply shared preference baselines."""
    distance_baseline = _minimum_positive(
        float(candidate.get("distance_m") or 0) for candidate in candidates
    )
    duration_baseline = _minimum_positive(
        float(candidate.get("duration_s") or 0) for candidate in candidates
    )
    return min(candidates, key=lambda candidate: _candidate_selection_key(
        candidate,
        route_preferences,
        baseline_distance_m=distance_baseline,
        baseline_duration_s=duration_baseline,
    ))


def _candidate_selection_key(
    candidate: dict[str, Any],
    route_preferences: dict[str, Any],
    *,
    baseline_distance_m: float,
    baseline_duration_s: float,
) -> tuple[float, float, float]:
    """Prefer target-distance fit, then compare preferences on common baselines."""
    target = _optional_float(candidate.get("target_distance_km"))
    distance = float(candidate.get("distance_km") or 0)
    target_deviation = abs(distance - target) / target if target and target > 0 else 0.0
    return (
        target_deviation,
        preference_score(
            candidate,
            route_preferences,
            baseline_distance_m=baseline_distance_m,
            baseline_duration_s=baseline_duration_s,
        ),
        distance,
    )


def _minimum_positive(values: Iterable[float]) -> float:
    positive = [float(value) for value in values if float(value) > 0]
    return min(positive, default=1.0)


def replace_candidate(
    plan: dict[str, Any],
    *,
    candidate_id: str | None,
    name: str,
    waypoint_queries: Sequence[str],
    target_distance_km: float | None,
    include_elevation: bool,
    route_constraints: dict[str, Any] | None = None,
    route_preferences: dict[str, Any] | None = None,
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
    country_code = str(plan.get("country_code") or "").strip().upper()
    config = load_config()
    if not use_amap_routes(country_code, config):
        ensure_google_route_provider_ready(config)
    updated = route_candidate(
        spec,
        index=selected_index + 1,
        country_code=country_code,
        include_elevation=include_elevation,
        config=config,
        route_constraints=route_constraints or plan.get("route_constraints"),
        route_preferences=route_preferences or plan.get("route_preferences"),
        provider_preflight_completed=True,
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
        "route_constraints": normalize_route_constraints(route_constraints or plan.get("route_constraints")),
        "route_preferences": normalize_route_preferences(route_preferences or plan.get("route_preferences")),
    }


def edit_candidate_waypoints(
    plan: dict[str, Any],
    *,
    candidate_id: str | None,
    operation: str,
    waypoint_index: int | None = None,
    new_waypoint: str | None = None,
    include_elevation: bool = True,
    route_constraints: dict[str, Any] | None = None,
    route_preferences: dict[str, Any] | None = None,
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
        route_constraints=route_constraints,
        route_preferences=route_preferences,
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
            candidates.append({**_compact_route_segment(item, id_key="candidate_id"),
                **{"has_previous_route": bool(item.get("last_successful_route"))},
                **{k: item.get(k) for k in ("day", "day_status", "distance_range_km", "waypoint_queries", "error", "failure", "connection_warning", "route_constraints", "route_preferences")}})
    return {
        "schema_version": "route_plan.v1",
        "itinerary_schema_version": plan.get("itinerary_schema_version"),
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
        "route_constraints": normalize_route_constraints(plan.get("route_constraints")),
        "route_preferences": normalize_route_preferences(plan.get("route_preferences")),
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
        "provider_alternative_count": item.get("provider_alternative_count"),
        "target_distance_km": item.get("target_distance_km"),
        "distance_delta_km": item.get("distance_delta_km"),
        "elevation_summary": {k: v for k, v in (elevation.get("summary") or {}).items()
                              if k in {"samples", "sample_spacing_m", "minimum_m", "maximum_m", "ascent_m", "descent_m"}},
        "ascent_preview": item.get("ascent_preview"),
        "warnings": item.get("warnings") or [],
        "strava_segments": [
            {key: value for key, value in segment.items() if key != "geometry"}
            for segment in item.get("strava_segments") or [] if isinstance(segment, dict)
        ],
        "segment_evidence": item.get("segment_evidence") or {},
        "candidate_kind": item.get("candidate_kind") or "baseline",
        "parent_candidate_id": item.get("parent_candidate_id"),
        "rationale": item.get("rationale"),
        "route_quality": item.get("route_quality") or {},
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
    route_constraints: dict[str, Any] | None = None,
    route_preferences: dict[str, Any] | None = None,
    provider_preflight_completed: bool = False,
    google_place_cache: dict[tuple[Any, ...], dict[str, Any]] | None = None,
    measurement_only: bool = False,
    allow_distance_mismatch: bool = False,
) -> dict[str, Any]:
    waypoint_queries, is_closed = normalize_waypoint_queries(candidate.get("waypoints") or [])
    queries = waypoint_queries[:-1] if is_closed else waypoint_queries
    if len(queries) < 2:
        raise ValueError("each candidate requires at least two distinct waypoint queries")
    target = _optional_float(candidate.get("target_distance_km"))
    prepared = candidate.get("_resolved_places")
    resolved_options = {}
    if prepared is not None:
        prepared = deepcopy(prepared[:-1] if is_closed else prepared)
        if len(prepared) != len(queries) or any(p.get("query") != q for p, q in zip(prepared, queries)):
            raise ValueError("prepared places do not match candidate waypoints")
        resolved_options = {"resolved_places": prepared}
    if use_amap_routes(country_code, config):
        places, route = _route_amap(
            queries,
            is_closed,
            config,
            target_distance_km=target,
            route_constraints=None if measurement_only else route_constraints,
            route_preferences=route_preferences,
            **resolved_options,
        )
    else:
        if not provider_preflight_completed:
            ensure_google_route_provider_ready(config)
        places, route = _route_google(
            queries, country_code, is_closed, config,
            target_distance_km=target,
            place_cache=google_place_cache,
            **resolved_options,
        )
    if is_closed:
        places = [*places, dict(places[0])]
    geometry = route["geometry"]
    distance_km = round(float(route.get("distance_m") or 0) / 1000, 1)
    warnings = list(route.get("warnings") or [])
    if route.get("warning"):
        warnings.append(str(route["warning"]))
    distance_error = target_distance_error(float(route.get("distance_m") or 0), target)
    if distance_error and not measurement_only and not allow_distance_mismatch:
        raise RouteCandidateRejected(distance_error)
    elevation = None
    if include_elevation and not measurement_only:
        try:
            elevation = _elevation_profile(geometry["coordinates"], float(route.get("distance_m") or 0), config)
        except (RuntimeError, ValueError) as exc:
            warnings.append(f"海拔请求失败：{exc}")
    resolved = {
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
        "legs": deepcopy(route.get("legs") or []),
        "navigation_steps": list(route.get("instructions") or []),
        "provider_alternative_count": int(route.get("provider_alternative_count") or 1),
        "baseline_distance_m": route.get("baseline_distance_m"),
        "baseline_duration_s": route.get("baseline_duration_s"),
        "route_quality": route.get("route_quality") or {},
        "elevation": elevation,
        "warnings": warnings,
    }
    if measurement_only:
        measured = apply_route_constraints({**resolved, "target_distance_km": None}, None)
        measured["target_distance_km"] = target
        return measured
    accepted = apply_route_constraints(
        {**resolved, "target_distance_km": None} if allow_distance_mismatch else resolved,
        route_constraints,
        rejection_type=RouteCandidateRejected,
    )
    accepted["target_distance_km"] = target
    return accepted


def validate_measured_candidate(
    result: dict[str, Any],
    constraints: dict[str, Any] | None = None,
    *,
    include_elevation: bool = False,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Accept an existing measurement without routing again; enrich finalists only."""
    accepted = apply_route_constraints(
        deepcopy(result), constraints, rejection_type=RouteCandidateRejected,
    )
    if include_elevation and accepted.get("elevation") is None:
        try:
            accepted["elevation"] = _elevation_profile(
                accepted["geometry"]["coordinates"], accepted["distance_m"],
                config if config is not None else load_config(),
            )
        except (RuntimeError, ValueError) as exc:
            accepted.setdefault("warnings", []).append(f"海拔请求失败：{exc}")
    return accepted


def _route_amap(
    queries: list[str],
    is_closed: bool,
    config: dict[str, Any],
    *,
    target_distance_km: float | None = None,
    route_constraints: dict[str, Any] | None = None,
    route_preferences: dict[str, Any] | None = None,
    resolved_places: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    amap = config.get("amap") if isinstance(config.get("amap"), dict) else {}
    key = str(amap.get("web_service_key") or "")
    if not key:
        raise ValueError("amap.web_service_key is not configured")
    places: list[dict[str, Any]] = deepcopy(resolved_places) if resolved_places is not None else []
    for query in ([] if resolved_places is not None else queries):
        anchor = places[-1] if places else None
        # This entry has no explicit city-only requirement. Cross-city stages
        # must not silently inherit the origin's administrative boundary.
        place = _search_amap_place(query, key, anchor=anchor)
        if places and target_distance_km:
            radius_km = target_distance_km * (0.6 if is_closed else 1.2)
            if _haversine_km(places[0]["latitude"], places[0]["longitude"],
                             place["latitude"], place["longitude"]) > radius_km:
                raise RouteCandidateRejected(
                    f"地点 {query} 超过起点范围 {radius_km:.1f} km",
                    code="place_outside_radius", stage="place_resolution",
                )
        places.append(place)
    points = [AmapPoint(place["latitude"], place["longitude"]) for place in places]
    if is_closed:
        points.append(points[0])
    leg_options = AmapCyclingRouter(key).route_point_leg_alternatives(
        points,
        alternative_route=3,
    )
    combinations = _amap_route_combinations(
        leg_options,
        route_preferences,
        route_constraints=route_constraints,
        target_distance_km=target_distance_km,
    )
    baseline_distance = sum(
        min(float(option.get("distance_m") or 0) for option in options)
        for options in leg_options
    )
    baseline_duration = sum(
        min(float(option.get("duration_s") or 0) for option in options)
        for options in leg_options
    )
    accepted: list[dict[str, Any]] = []
    rejected: list[str] = []
    for route in combinations:
        display_coordinates = [
            list(gcj02_to_wgs84(lon, lat)) for lon, lat in route["geometry"]
        ]
        candidate = {
            **route,
            "travel_mode": "BICYCLE",
            "geometry": {"type": "LineString", "coordinates": display_coordinates},
            "navigation_steps": list(route.get("instructions") or []),
            "baseline_distance_m": baseline_distance,
            "baseline_duration_s": baseline_duration,
            "provider_alternative_count": len(combinations),
        }
        try:
            candidate = apply_route_constraints(
                candidate,
                route_constraints,
                rejection_type=RouteCandidateRejected,
            )
        except RouteCandidateRejected as exc:
            rejected.append(str(exc))
            continue
        score = preference_score(candidate, route_preferences)
        candidate["route_quality"] = {
            **candidate["route_quality"],
            "preference_score": score,
        }
        accepted.append(candidate)
    if not accepted:
        details = "；".join(rejected[:3]) or "高德没有返回可用备选"
        raise RouteCandidateRejected(f"高德骑行备选均未满足路线要求：{details}")
    accepted.sort(key=lambda item: (
        (
            abs(float(item.get("distance_m") or 0) / 1000.0 - target_distance_km)
            / target_distance_km
            if target_distance_km is not None and target_distance_km > 0
            else 0.0
        ),
        float((item.get("route_quality") or {}).get("preference_score") or 0),
        float(item.get("distance_m") or 0),
        float(item.get("duration_s") or 0),
    ))
    return places, accepted[0]


def _amap_route_combinations(
    leg_options: Sequence[Sequence[dict[str, Any]]],
    route_preferences: dict[str, Any] | None,
    *,
    route_constraints: dict[str, Any] | None = None,
    target_distance_km: float | None = None,
    beam_width: int = 24,
) -> list[dict[str, Any]]:
    """Compose bounded multi-leg alternatives without a combinatorial explosion."""
    partials: list[list[dict[str, Any]]] = [[]]
    for leg_index, options in enumerate(leg_options):
        if not options:
            raise RuntimeError("AMap returned no usable alternative for one route leg")
        expanded = [
            [*partial, option]
            for partial in partials
            for option in options
        ]
        remaining_options = leg_options[leg_index + 1:]
        remaining_minimum_m = sum(
            min(float(option.get("distance_m") or 0) for option in choices)
            for choices in remaining_options
        )
        remaining_maximum_m = sum(
            max(float(option.get("distance_m") or 0) for option in choices)
            for choices in remaining_options
        )
        ranked: list[tuple[float, float, float, float, list[dict[str, Any]]]] = []
        for legs in expanded:
            route = compose_amap_legs(legs)
            partial_constraints = normalize_route_constraints(route_constraints)
            partial_constraints.update({
                "avoid_repeated_roads": False,
                "maximum_detour_ratio": None,
            })
            try:
                candidate = apply_route_constraints(
                    {
                        **route,
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [list(point) for point in route["geometry"]],
                        },
                        "navigation_steps": route.get("instructions") or [],
                        "baseline_distance_m": sum(
                            min(float(option.get("distance_m") or 0) for option in choices)
                            for choices in leg_options[:len(legs)]
                        ),
                        "baseline_duration_s": sum(
                            min(float(option.get("duration_s") or 0) for option in choices)
                            for choices in leg_options[:len(legs)]
                        ),
                    },
                    partial_constraints,
                    rejection_type=RouteCandidateRejected,
                )
            except RouteCandidateRejected:
                continue
            partial_distance_m = float(route.get("distance_m") or 0)
            ranked.append((
                _target_reachability_gap(
                    partial_distance_m + remaining_minimum_m,
                    partial_distance_m + remaining_maximum_m,
                    target_distance_km,
                ),
                preference_score(candidate, route_preferences),
                partial_distance_m,
                float(route.get("duration_s") or 0),
                legs,
            ))
        ranked.sort(key=lambda item: item[:4])
        if not ranked:
            raise RouteCandidateRejected("高德所有分段备选都违反掉头或特殊通行约束")
        partials = [item[4] for item in ranked[:max(1, beam_width)]]
    return [compose_amap_legs(legs) for legs in partials]


def _target_reachability_gap(
    minimum_distance_m: float,
    maximum_distance_m: float,
    target_distance_km: float | None,
) -> float:
    """Rank partial combinations by whether remaining legs can reach the target."""
    if target_distance_km is None or target_distance_km <= 0:
        return 0.0
    target_m = target_distance_km * 1000.0
    if target_m < minimum_distance_m:
        return minimum_distance_m - target_m
    if target_m > maximum_distance_m:
        return target_m - maximum_distance_m
    return 0.0


def resolve_google_places(
    queries: list[str],
    country_code: str,
    is_closed: bool,
    config: dict[str, Any],
    *,
    target_distance_km: float | None = None,
    place_cache: dict[tuple[Any, ...], dict[str, Any]] | None = None,
    point_intents: dict[str, dict] | None = None,
    locality_names: tuple[str, ...] = (),
    locality_scope: str = "city",
    origin_locality_evidence: dict | None = None,
    point_radius_km: float | None = None,
) -> list[dict[str, Any]]:
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
    if point_radius_km is not None:
        maximum_radius_km = point_radius_km
    for query in queries:
        anchor = places[0] if places else None
        names = locality_names if anchor is None or locality_scope == "city" else ()
        origin_evidence = origin_locality_evidence if anchor is None and locality_scope != "city" else None
        near = (
            (float(anchor["latitude"]), float(anchor["longitude"]))
            if anchor is not None and maximum_radius_km is not None else None
        )
        search_radius_m = min(
            MAX_GOOGLE_PLACE_BIAS_RADIUS_M,
            maximum_radius_km * 1_000 if maximum_radius_km is not None else 20_000,
        )
        # Bias changes the meaning of a query. Keep exact coordinates/radius
        # in the key; do not merge searches around different origins.
        anchor_key = (
            (float(anchor["latitude"]), float(anchor["longitude"])) if anchor is not None else None
        )
        cache_key = (country_code, query, anchor_key, near, search_radius_m if near is not None else None)
        if point_intents is not None:
            cache_key += (str(sorted((point_intents.get(query) or {}).items())), tuple(names), str(origin_evidence), maximum_radius_km)
        cached = place_cache.get(cache_key) if place_cache is not None else None
        if cached is not None:
            place = deepcopy(cached)
        else:
            if point_intents is not None:
                from services.route.place_resolution import resolve_place
                raw = resolve_place(client, query, country=country_code,
                    intent=point_intents.get(query) or {}, locality_names=names,
                    anchor=anchor, radius_km=maximum_radius_km, origin_locality_evidence=origin_evidence)
            else:
                results = client.search(query, near=near, radius_m=search_radius_m, limit=5).get("places") or []
                if not results:
                    raise RouteCandidateRejected(
                        f"地点检索没有结果：{query}",
                        code="place_not_found",
                        stage="place_resolution",
                    )
                raw = _select_google_place(results, query=query, country_code=country_code, anchor=anchor)
            location = raw["location"]
            place = {
                "types": raw.get("types") or [],
                "resolution_evidence": raw.get("resolution_evidence"),
                "query": query,
                "place_id": raw.get("place_id") or raw.get("id") or "",
                "localities": raw.get("localities") or [],
                "country_code": raw.get("country_code") or "",
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
        if place_cache is not None:
            place_cache[cache_key] = deepcopy(place)
        places.append(place)
    return places


def _route_google(
    queries: list[str], country_code: str, is_closed: bool, config: dict[str, Any], *,
    target_distance_km: float | None = None,
    place_cache: dict[tuple[Any, ...], dict[str, Any]] | None = None,
    resolved_places: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    places = deepcopy(resolved_places) if resolved_places is not None else resolve_google_places(
        queries, country_code, is_closed, config,
        target_distance_km=target_distance_km, place_cache=place_cache,
    )
    # Cached domestic materials retain native GCJ-02 and WGS84 coordinates.
    # Google must only receive WGS84 when an explicit provider override is used.
    for place in places:
        if "display_latitude" in place and "display_longitude" in place:
            place["latitude"] = place["display_latitude"]
            place["longitude"] = place["display_longitude"]
    key = str((config.get("google") or {}).get("api_key") or "")
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
    # Named route anchors need text relevance first. Nearby search sorted by
    # distance can otherwise turn a landmark into an adjacent hotel or shop.
    params: dict[str, Any] = {"key": key, "keywords": query, "page_size": 25}
    if region:
        params["region"] = region
        params["city_limit"] = "true"
    payload = _read_json_url(
        AMAP_PLACE_TEXT_URL + "?" + urlencode(params),
        provider="AMap Places",
        direct_first=True,
    )
    validate_amap_response(payload, stage="place_search")
    pois = payload.get("pois") or []
    if not pois and anchor is not None:
        fallback = {
            "key": key,
            "keywords": query,
            "page_size": 25,
            "location": f"{float(anchor['longitude']):.6f},{float(anchor['latitude']):.6f}",
            "radius": 50_000,
            "sortrule": "weight",
        }
        if region:
            fallback["region"] = region
            fallback["city_limit"] = "true"
        payload = _read_json_url(
            AMAP_PLACE_AROUND_URL + "?" + urlencode(fallback),
            provider="AMap Places",
            direct_first=True,
        )
        validate_amap_response(payload, stage="place_search")
        pois = payload.get("pois") or []
    if not pois:
        raise RouteCandidateRejected(
            f"地点检索没有结果：{query}",
            code="place_not_found",
            stage="place_resolution",
        )
    poi = _select_amap_poi(query, pois, anchor=anchor)
    try:
        lon, lat = (float(value) for value in str(poi["location"]).split(",", 1))
    except (KeyError, TypeError, ValueError) as exc:
        raise RouteCandidateRejected(
            f"地点没有可用坐标：{query}",
            code="place_invalid",
            stage="place_resolution",
        ) from exc
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
        "localities": [str(poi["cityname"])] if poi.get("cityname") else [],
    }


def _select_amap_poi(
    query: str, pois: Sequence[dict[str, Any]], *, anchor: dict[str, Any] | None,
) -> dict[str, Any]:
    normalized_query = _normalize_place_name(query)

    def score(poi: dict[str, Any]) -> tuple[float, float]:
        match = _amap_poi_match_score(normalized_query, poi)
        distance = _amap_poi_distance_km(poi, anchor)
        return match, -distance

    selected = max((poi for poi in pois if isinstance(poi, dict)), key=score)
    if _amap_poi_match_score(normalized_query, selected) <= 0:
        raise RouteCandidateRejected(f"地点检索结果与“{query}”不匹配")
    return selected


def _amap_poi_match_score(normalized_query: str, poi: dict[str, Any]) -> float:
    name = _normalize_place_name(str(poi.get("name") or ""))
    address = _normalize_place_name(str(poi.get("address") or ""))
    searchable = name + address
    # Provider names can insert a scenic-area designation between the parent
    # attraction and sub-attraction. Full identity outranks ancillary POIs
    # merely containing the query (parking, ticket offices, shuttle stops).
    if name and normalized_query and (
        name == normalized_query
        or name.replace("景区", "") == normalized_query.replace("景区", "")
    ):
        return 5.0
    if name and normalized_query and (normalized_query in name or name in normalized_query):
        return 4.0
    if normalized_query and normalized_query in searchable:
        return 3.5
    query_pairs = _character_pairs(normalized_query)
    if not query_pairs:
        return 0.0
    overlap = len(query_pairs & _character_pairs(searchable)) / len(query_pairs)
    return overlap if overlap >= 0.4 else 0.0


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
        raise ProviderError(
            str(payload.get("error_message") or payload.get("status") or "provider error"),
            provider="google_elevation",
            stage="elevation",
        )
    results = payload.get("results") or []
    if len(results) < 2:
        raise ProviderError(
            "Google Elevation returned too few samples",
            provider="google_elevation",
            stage="elevation",
            code="provider_invalid_response",
        )
    try:
        elevations = [float(item["elevation"]) for item in results]
        if not all(math.isfinite(value) for value in elevations):
            raise ValueError("non-finite elevation")
    except (KeyError, TypeError, ValueError) as exc:
        raise ProviderError("Google Elevation returned invalid samples", provider="google_elevation",
                            stage="elevation", code="provider_invalid_response") from exc
    smoothed = [
        sum(elevations[max(0, index - 1):min(len(elevations), index + 2)])
        / len(elevations[max(0, index - 1):min(len(elevations), index + 2)])
        for index in range(len(elevations))
    ]
    step_m = distance_m / (len(elevations) - 1)
    ascent = sum(max(0.0, second - first) for first, second in zip(smoothed, smoothed[1:]))
    descent = sum(max(0.0, first - second) for first, second in zip(smoothed, smoothed[1:]))
    return {
        "kind": "route_elevation",
        "provider": "google_elevation",
        "usage": "ascent_reference_only",
        "summary": {
            "samples": len(elevations),
            "sample_spacing_m": round(step_m),
            "minimum_m": round(min(elevations)),
            "maximum_m": round(max(elevations)),
            "ascent_m": round(ascent),
            "descent_m": round(descent),
        },
        "labels": [round(distance_m * index / (len(elevations) - 1) / 1000, 1) for index in range(len(elevations))],
        "elevations_m": [round(value, 1) for value in elevations],
    }


def _read_json_url(
    url: str,
    *,
    provider: str,
    direct_first: bool = False,
) -> dict[str, Any]:
    normalized_provider, stage = _provider_identity(provider)
    if normalized_provider == "amap_places":
        return _read_amap_places_json(url, direct_first=direct_first)

    last_error: Exception | None = None
    proxy_handlers = (
        (ProxyHandler({}), ProxyHandler())
        if direct_first
        else (ProxyHandler(), ProxyHandler({}))
    )
    # Optional elevation must not exhaust the candidate comparison latency budget.
    for attempt in range(1 if normalized_provider == "google_elevation" else 3):
        for proxy_handler in proxy_handlers:
            try:
                timeout = 25
                if normalized_provider == "google_elevation":
                    from integrations.route_providers.budget import consume_route_request
                    timeout = consume_route_request(8)
                with build_opener(proxy_handler).open(url, timeout=timeout) as response:
                    value = json.load(response)
                if not isinstance(value, dict):
                    raise ProviderError(
                        f"{provider} returned invalid JSON",
                        provider=normalized_provider,
                        stage=stage,
                        code="provider_invalid_response",
                    )
                return value
            except HTTPError as exc:
                if exc.code in {408, 429} or exc.code >= 500:
                    last_error = exc
                    continue
                raise ProviderError(
                    f"{provider} returned HTTP {exc.code}",
                    provider=normalized_provider,
                    stage=stage,
                    code="provider_http_error",
                ) from exc
            except json.JSONDecodeError as exc:
                raise ProviderError(
                    f"{provider} returned invalid JSON",
                    provider=normalized_provider,
                    stage=stage,
                    code="provider_invalid_response",
                ) from exc
            except (OSError, TimeoutError, URLError) as exc:
                last_error = exc
        time.sleep(0.4 * (attempt + 1))
    raise TransientProviderError(
        f"{provider} request failed: {last_error.__class__.__name__ if last_error else 'unknown'}",
        provider=normalized_provider,
        stage=stage,
    )


def _provider_identity(provider: str) -> tuple[str, str]:
    normalized = str(provider or "").strip().lower()
    if "amap" in normalized:
        return "amap_places", "place_search"
    if "elevation" in normalized:
        return "google_elevation", "elevation"
    return "route_provider", "provider_request"


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


def _read_amap_places_json(url, *, direct_first=False):
    """Bound all Places attempts, including HTTP-200 API-level throttling."""
    from integrations.route_providers.amap_throttle import pace, retry_wait
    from integrations.route_providers.budget import consume_route_request
    handlers = (ProxyHandler({}), ProxyHandler()) if direct_first else (ProxyHandler(), ProxyHandler({}))
    for attempt in range(3):
        pace(url)
        try:
            with build_opener(handlers[attempt % len(handlers)]).open(
                url, timeout=consume_route_request(25),
            ) as response:
                value = json.load(response)
            if not isinstance(value, dict):
                raise ProviderError("AMap Places 返回了无效响应", provider="amap", stage="place_search")
            validate_amap_response(value, stage="place_search")
            return value
        except TransientProviderError:
            if attempt == 2:
                raise
        except HTTPError as exc:
            if exc.code not in {408, 429} and exc.code < 500:
                raise ProviderError(f"AMap Places HTTP {exc.code}", provider="amap", stage="place_search") from exc
            if attempt == 2:
                raise TransientProviderError(f"AMap Places HTTP {exc.code}", provider="amap", stage="place_search") from exc
        except (OSError, TimeoutError, URLError) as exc:
            if attempt == 2:
                raise TransientProviderError("AMap Places 网络请求失败", provider="amap", stage="place_search") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError("AMap Places 返回了非 JSON 响应", provider="amap", stage="place_search") from exc
        retry_wait(attempt)
