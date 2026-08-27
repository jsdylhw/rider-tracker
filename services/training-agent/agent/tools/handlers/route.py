"""Agent adapter for route-advice generation."""

from __future__ import annotations

import json
from typing import Any

from agent.main_agent.context import AgentContext
from integrations.llm import AnthropicMessagesClient, extract_text
from integrations.strava import StravaSink
from services.route.advice import generate_route_advice as generate_route_advice_service
from services.route.itinerary import (
    create_itinerary_plan as create_itinerary_plan_service,
    edit_itinerary_stage_waypoints,
    refresh_itinerary_plan,
    replace_itinerary_stage,
)
from services.route.segment_aware import (
    apply_segment_aware_routing,
    build_connector_router,
    compose_route_with_segments,
    reverse_segment_candidate,
)
from services.route.segments import enrich_route_plan_with_segments
from services.route.popular_loop import create_popular_loop_plan, reverse_popular_loop_plan
from services.route.single_day import (
    _elevation_profile,
    compact_route_plan,
    create_single_day_plan,
    edit_candidate_waypoints,
    replace_candidate,
)
from settings import load_config
from storage.repositories.route import RoutePlanStore


def generate_route_advice(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return generate_route_advice_tool(context, args=args, name="generate_route_advice")


def create_route_plan(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return create_route_plan_tool(context, args=args, name="create_route_plan")


def create_itinerary_plan(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return create_itinerary_plan_tool(context, args=args, name="create_itinerary_plan")


def update_route_plan(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return update_route_plan_tool(context, args=args, name="update_route_plan")


def get_route_plan(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return get_route_plan_tool(context, args=args, name="get_route_plan")


def explore_route_segments(args: dict[str, Any], context: AgentContext) -> dict[str, Any]:
    return explore_route_segments_tool(context, args=args, name="explore_route_segments")


def generate_route_advice_tool(
    context: AgentContext,
    *,
    args: dict[str, Any] | None = None,
    name: str = "generate_route_advice",
) -> dict[str, Any]:
    """Extract conversational inputs before calling the context-free service."""
    return generate_route_advice_service(
        args=args,
        training_load=_training_load(context),
        user_message=_latest_user_message(context),
        advisor=_request_route_advice,
        name=name,
    )


def create_route_plan_tool(
    context: AgentContext,
    *,
    args: dict[str, Any] | None = None,
    name: str = "create_route_plan",
) -> dict[str, Any]:
    args = args or {}
    request_options = (
        context.route_request_options
        if isinstance(context.route_request_options, dict) else {}
    )
    include_elevation = (
        bool(request_options["include_elevation"])
        if "include_elevation" in request_options
        else bool(args.get("include_elevation", True))
    )
    segment_strategy = str(args.get("segment_strategy") or "auto").lower()
    country_code = str(args.get("country_code") or "")
    if segment_strategy == "complete_loop":
        plan = create_popular_loop_plan(
            workspace_id=_workspace_id(context),
            title=str(args.get("title") or "热门环线"),
            country_code=country_code,
            origin=str(args.get("origin") or ""),
            area=str(args.get("area") or ""),
            segment_name_hint=str(args.get("segment_name_hint") or ""),
            target_distance_km=args.get("target_distance_km"),
            search_radius_km=float(args.get("search_radius_km", 8.0)),
            include_elevation=include_elevation,
            fallback_to_provider=bool(args.get("fallback_to_provider", True)),
        )
        stored = RoutePlanStore().save(plan)
        compact = compact_route_plan(stored)
        prefix = "已生成热门环线" if stored.get("route_mode") == "popular_loop" else "已降级生成普通地图路线"
        return {
            "step": name,
            "status": "completed",
            "answer": _plan_answer(compact, prefix=prefix),
            "result": compact,
        }
    segment_active = segment_strategy != "ignore"
    candidates = args.get("candidates") if isinstance(args.get("candidates"), list) else []
    if not candidates and isinstance(args.get("waypoints"), list):
        candidates = [{
            "name": args.get("candidate_name") or "推荐路线",
            "waypoints": args["waypoints"],
            "target_distance_km": args.get("target_distance_km"),
        }]
    plan_target_distance = args.get("target_distance_km")
    candidates = [
        {
            **candidate,
            **(
                {"target_distance_km": plan_target_distance}
                if candidate.get("target_distance_km") is None and plan_target_distance is not None
                else {}
            ),
        }
        for candidate in candidates if isinstance(candidate, dict)
    ]
    plan = create_single_day_plan(
        workspace_id=_workspace_id(context),
        title=str(args.get("title") or "单日骑行路线"),
        country_code=country_code,
        candidates=candidates,
        include_elevation=include_elevation and not segment_active,
    )
    if segment_active:
        plan = _apply_segment_strategy(
            plan,
            context=context,
            strategy=segment_strategy,
            preferences=args.get("segment_preferences") or [],
            include_elevation=include_elevation,
        )
    plan = _mark_route_proposed(plan, include_elevation=include_elevation)
    stored = RoutePlanStore().save(plan)
    compact = compact_route_plan(stored)
    return {
        "step": name,
        "status": "completed",
        "answer": _plan_answer(compact, prefix="已生成"),
        "result": compact,
    }


def create_itinerary_plan_tool(
    context: AgentContext,
    *,
    args: dict[str, Any] | None = None,
    name: str = "create_itinerary_plan",
) -> dict[str, Any]:
    args = args or {}
    segment_strategy = str(args.get("segment_strategy") or "auto").lower()
    country_code = str(args.get("country_code") or "")
    segment_active = segment_strategy != "ignore"
    candidates = args.get("candidates") if isinstance(args.get("candidates"), list) else []
    plan = create_itinerary_plan_service(
        workspace_id=_workspace_id(context),
        title=str(args.get("title") or "分段骑行路线"),
        country_code=country_code,
        schedule_type=str(args.get("schedule_type") or ""),
        candidates=candidates,
        include_elevation=bool(args.get("include_elevation", True)) and not segment_active,
        handoff_tolerance_km=args.get("handoff_tolerance_km", 5.0),
        balance_warning_ratio=args.get("balance_warning_ratio", 0.30),
    )
    if segment_active:
        plan = _apply_segment_strategy(
            plan,
            context=context,
            strategy=segment_strategy,
            preferences=args.get("segment_preferences") or [],
            include_elevation=bool(args.get("include_elevation", True)),
        )
        plan = refresh_itinerary_plan(plan)
    stored = RoutePlanStore().save(plan)
    compact = compact_route_plan(stored)
    return {
        "step": name,
        "status": "completed",
        "answer": _plan_answer(compact, prefix="已生成"),
        "result": compact,
    }


def update_route_plan_tool(
    context: AgentContext,
    *,
    args: dict[str, Any] | None = None,
    name: str = "update_route_plan",
) -> dict[str, Any]:
    args = args or {}
    store = RoutePlanStore()
    plan_id = str(args.get("plan_id") or "").strip()
    plan = _load_plan(store, context, plan_id)
    if not plan:
        raise ValueError("没有可更新的路线计划，请先创建路线")
    operation = str(args.get("operation") or "replace_waypoints")
    expected_revision = _expected_revision(args)
    if operation == "undo":
        restored = (
            store.undo(str(plan.get("plan_id") or ""), expected_revision=expected_revision)
            if expected_revision is not None
            else store.undo(str(plan.get("plan_id") or ""))
        )
        if not restored:
            raise ValueError("当前路线没有可以撤销的上一版本")
        compact = compact_route_plan(restored)
        return {
            "step": name,
            "status": "completed",
            "answer": _plan_answer(compact, prefix="已撤销到上一版"),
            "result": compact,
        }
    if plan.get("route_mode") == "popular_loop" and operation not in {
        "reverse_candidate", "select_candidate", "confirm_candidate",
    }:
        raise ValueError("热门环线更换起点、区域或名称时请重新调用 create_route_plan，并使用 complete_loop 策略")
    segment_strategy = str(args.get("segment_strategy") or plan.get("segment_strategy") or "ignore").lower()
    staged_plan = plan.get("schedule_type") in {"multi_day", "day_parts"}
    segment_active = (
        segment_strategy != "ignore"
        and operation not in {"select_candidate", "confirm_candidate", "compose_segments"}
        and (staged_plan or "segment_strategy" in args)
    )
    planning = plan.get("planning") if isinstance(plan.get("planning"), dict) else {}
    defer_elevation = not staged_plan and planning.get("status") == "awaiting_selection"
    route_include_elevation = (
        bool(args.get("include_elevation", True)) and not segment_active and not defer_elevation
    )
    if operation == "select_candidate":
        selected_id = str(args.get("candidate_id") or "")
        valid_ids = {str(item.get("candidate_id")) for item in plan.get("candidates") or [] if isinstance(item, dict)}
        if selected_id not in valid_ids:
            raise ValueError("route candidate does not exist")
        plan = {**plan, "active_candidate_id": selected_id}
    elif operation == "confirm_candidate":
        selected_id = str(args.get("candidate_id") or plan.get("active_candidate_id") or "")
        valid_ids = {str(item.get("candidate_id")) for item in plan.get("candidates") or [] if isinstance(item, dict)}
        if selected_id not in valid_ids:
            raise ValueError("route candidate does not exist")
        include_elevation = (
            bool(args["include_elevation"])
            if "include_elevation" in args
            else bool(planning.get("include_elevation", True))
        )
        plan = _confirm_route_candidate(plan, selected_id, include_elevation=include_elevation)
    elif operation == "compose_segments":
        if plan.get("schedule_type") in {"multi_day", "day_parts"}:
            raise ValueError("compose_segments currently supports single-day routes only")
        config = load_config()
        amap = config.get("amap") if isinstance(config.get("amap"), dict) else {}
        google = config.get("google") if isinstance(config.get("google"), dict) else {}
        country_code = str(plan.get("country_code") or "").upper()
        sink = StravaSink(config)
        segment_args = args.get("segments") if isinstance(args.get("segments"), list) else []
        plan = compose_route_with_segments(
            plan,
            candidate_id=str(args.get("candidate_id") or "") or None,
            segments=segment_args,
            connector_router=build_connector_router(
                country_code=country_code,
                amap_key=str(amap.get("web_service_key") or ""),
                google_key=str(google.get("api_key") or ""),
            ),
            detail_fetcher=lambda segment_id: sink.get_segment(segment_id),
            target_distance_km=args.get("target_distance_km"),
            name=str(args.get("candidate_name") or ""),
        )
    elif operation == "replace_waypoints":
        if plan.get("schedule_type") in {"multi_day", "day_parts"}:
            raise ValueError("分段行程请使用 replace_stage")
        waypoints = args.get("waypoints") if isinstance(args.get("waypoints"), list) else []
        plan = replace_candidate(
            plan,
            candidate_id=str(args.get("candidate_id") or "") or None,
            name=str(args.get("candidate_name") or ""),
            waypoint_queries=[str(value) for value in waypoints],
            target_distance_km=args.get("target_distance_km"),
            include_elevation=route_include_elevation,
        )
    elif operation == "replace_stage":
        if plan.get("schedule_type") not in {"multi_day", "day_parts"}:
            raise ValueError("replace_stage requires a multi-day or day-parts plan")
        waypoints = args.get("waypoints") if isinstance(args.get("waypoints"), list) else []
        plan = replace_itinerary_stage(
            plan,
            candidate_id=str(args.get("candidate_id") or "") or None,
            stage_id=str(args.get("stage_id") or ""),
            label=str(args.get("stage_label") or ""),
            waypoint_queries=[str(value) for value in waypoints],
            target_distance_km=args.get("target_distance_km"),
            include_elevation=route_include_elevation,
        )
    elif operation == "reverse_candidate":
        if plan.get("schedule_type") in {"multi_day", "day_parts"}:
            raise ValueError("分段行程请使用 reverse_stage")
        if plan.get("route_mode") == "popular_loop":
            plan = reverse_popular_loop_plan(
                plan, candidate_id=str(args.get("candidate_id") or "") or None,
            )
            segment_active = False
        else:
            selected_id = str(args.get("candidate_id") or plan.get("active_candidate_id") or "")
            selected = next(
                (item for item in plan.get("candidates") or []
                 if isinstance(item, dict) and str(item.get("candidate_id") or "") == selected_id),
                None,
            )
            if isinstance(selected, dict) and selected.get("strava_segments"):
                plan = reverse_segment_candidate(plan, candidate_id=selected_id)
                segment_active = False
            else:
                plan = edit_candidate_waypoints(
                    plan,
                    candidate_id=selected_id or None,
                    operation="reverse",
                    include_elevation=route_include_elevation,
                )
    elif operation == "reverse_stage":
        if plan.get("schedule_type") not in {"multi_day", "day_parts"}:
            raise ValueError("reverse_stage requires a multi-day or day-parts plan")
        plan = edit_itinerary_stage_waypoints(
            plan,
            candidate_id=str(args.get("candidate_id") or "") or None,
            stage_id=str(args.get("stage_id") or ""),
            operation="reverse",
            include_elevation=route_include_elevation,
        )
    elif operation == "replace_waypoint":
        common = {
            "candidate_id": str(args.get("candidate_id") or "") or None,
            "operation": "replace_waypoint",
            "waypoint_index": args.get("waypoint_index"),
            "new_waypoint": str(args.get("new_waypoint") or ""),
            "include_elevation": route_include_elevation,
        }
        if plan.get("schedule_type") in {"multi_day", "day_parts"}:
            plan = edit_itinerary_stage_waypoints(
                plan,
                stage_id=str(args.get("stage_id") or ""),
                **common,
            )
        else:
            plan = edit_candidate_waypoints(plan, **common)
    else:
        raise ValueError(
            "operation must be replace_waypoints, replace_stage, replace_waypoint, "
            "reverse_candidate, reverse_stage, select_candidate, compose_segments, "
            "confirm_candidate or undo"
        )
    if segment_active:
        plan = _apply_segment_strategy(
            plan,
            context=context,
            strategy=segment_strategy,
            preferences=args.get("segment_preferences") or plan.get("segment_preferences") or [],
            include_elevation=bool(args.get("include_elevation", True)),
        )
        if plan.get("schedule_type") in {"multi_day", "day_parts"}:
            plan = refresh_itinerary_plan(plan)
    stored = _save_route_plan(
        store,
        plan,
        archive=operation != "select_candidate",
        expected_revision=expected_revision,
    )
    compact = compact_route_plan(stored)
    return {
        "step": name,
        "status": "completed",
        "answer": _plan_answer(compact, prefix="已更新"),
        "result": compact,
    }


def get_route_plan_tool(
    context: AgentContext,
    *,
    args: dict[str, Any] | None = None,
    name: str = "get_route_plan",
) -> dict[str, Any]:
    args = args or {}
    store = RoutePlanStore()
    plan_id = str(args.get("plan_id") or "").strip()
    plan = _load_plan(store, context, plan_id)
    if not plan:
        raise ValueError("没有已保存的路线计划")
    compact = compact_route_plan(plan)
    return {
        "step": name,
        "status": "completed",
        "answer": _plan_answer(compact, prefix="当前路线"),
        "result": compact,
    }


def explore_route_segments_tool(
    context: AgentContext,
    *,
    args: dict[str, Any] | None = None,
    name: str = "explore_route_segments",
) -> dict[str, Any]:
    args = args or {}
    store = RoutePlanStore()
    plan = _load_plan(store, context, str(args.get("plan_id") or "").strip())
    if not plan:
        raise ValueError("没有已保存的路线计划，请先创建路线")
    sink = StravaSink()
    updated, result = enrich_route_plan_with_segments(
        plan,
        access_token=str(sink.access_token or ""),
        candidate_id=str(args.get("candidate_id") or "") or None,
        stage_id=str(args.get("stage_id") or "") or None,
        corridor_km=args.get("corridor_km", 5.0),
        max_segments=args.get("max_segments", 12),
        explorer=lambda bounds, _token: sink.explore_segments(bounds),
    )
    # Segment discovery enriches the current route but is not itself a route
    # edit. Do not make a later conversational undo stop at this metadata-only
    # revision instead of restoring the previous waypoint/geometry version.
    stored = _save_route_plan(
        store,
        updated,
        archive=False,
        expected_revision=_expected_revision(args),
    )
    result = {**result, "revision": stored.get("revision")}
    return {
        "step": name,
        "status": "completed",
        "answer": (
            f"已在当前路线附近找到 {result['segment_count']} 个 Strava 热门骑行路段样本；"
            f"筛选走廊为 {result['corridor_km']} km。"
        ),
        "result": result,
    }


def _expected_revision(args: dict[str, Any]) -> int | None:
    value = args.get("_expected_revision")
    if value is None:
        return None
    revision = int(value)
    if revision < 1:
        raise ValueError("expected_revision must be a positive integer")
    return revision


def _save_route_plan(
    store: RoutePlanStore,
    plan: dict[str, Any],
    *,
    archive: bool,
    expected_revision: int | None,
) -> dict[str, Any]:
    if expected_revision is None:
        return store.save(plan, archive=False) if not archive else store.save(plan)
    return store.save(plan, archive=archive, expected_revision=expected_revision)


def _workspace_id(context: AgentContext) -> str:
    return str(context.workspace_id or context.session_id)


def _load_plan(
    store: RoutePlanStore,
    context: AgentContext,
    plan_id: str,
) -> dict[str, Any] | None:
    workspace_id = _workspace_id(context)
    plan = store.get(plan_id) if plan_id else store.get_latest(workspace_id)
    if plan and str(plan.get("workspace_id") or "") != workspace_id:
        raise ValueError("route plan does not belong to the current workspace")
    return plan


def _plan_answer(plan: dict[str, Any], *, prefix: str) -> str:
    candidates = [item for item in plan.get("candidates") or [] if isinstance(item, dict)]
    active_id = plan.get("active_candidate_id")
    active = next((item for item in candidates if item.get("candidate_id") == active_id), candidates[0] if candidates else {})
    answer = (
        f"{prefix}：{plan.get('title') or '单日路线'}；"
        f"当前候选 {active.get('name') or '-'}，{active.get('distance_km') or 0} km，"
        f"预计 {active.get('duration_min') or 0} 分钟。"
    )
    planning = plan.get("planning") if isinstance(plan.get("planning"), dict) else {}
    if planning.get("status") == "awaiting_selection":
        answer += f" 当前共有 {len(candidates)} 条候选，尚未最终确认；可以选择候选或继续按语义修改。"
    elif planning.get("status") == "confirmed":
        answer += " 该候选已确认保存。"
    rejected = [item for item in plan.get("rejected_candidates") or [] if isinstance(item, dict)]
    if rejected:
        details = "；".join(
            f"{item.get('name') or '未命名候选'}：{item.get('reason') or '超出合理范围'}"
            for item in rejected
        )
        answer += f" 已淘汰 {len(rejected)} 条异常候选（{details}）。"
    return answer


def _request_route_advice(system: str, user: str) -> str:
    """Own the LLM call at the Agent boundary and return only its text."""
    response = AnthropicMessagesClient().create_message(
        system=system,
        user=user,
        max_tokens=1200,
        temperature=0.4,
    )
    return extract_text(response)


def _apply_segment_strategy(
    plan: dict[str, Any],
    *,
    context: AgentContext,
    strategy: str,
    preferences: Any,
    include_elevation: bool,
    proposal_mode: bool = False,
) -> dict[str, Any]:
    config = load_config()
    amap = config.get("amap") if isinstance(config.get("amap"), dict) else {}
    google = config.get("google") if isinstance(config.get("google"), dict) else {}
    country_code = str(plan.get("country_code") or "").upper()
    normalized_preferences = [str(value) for value in preferences if str(value).strip()] if isinstance(preferences, list) else []
    elevation_builder = lambda coordinates, distance_m: _elevation_profile(coordinates, distance_m, config)
    try:
        sink = StravaSink(config)
        return apply_segment_aware_routing(
            plan,
            strategy=strategy,
            access_token=str(sink.access_token or ""),
            amap_key=str(amap.get("web_service_key") or ""),
            google_key=str(google.get("api_key") or ""),
            connector_router=build_connector_router(
                country_code=country_code,
                amap_key=str(amap.get("web_service_key") or ""),
                google_key=str(google.get("api_key") or ""),
            ),
            request_text=_latest_user_message(context),
            preferences=normalized_preferences,
            include_elevation=include_elevation,
            explorer=lambda bounds, _token: sink.explore_segments(bounds),
            detail_fetcher=lambda segment_id: sink.get_segment(segment_id),
            selector=_request_segment_selection,
            elevation_builder=elevation_builder,
            preserve_baseline=proposal_mode,
        )
    except Exception as exc:  # noqa: BLE001 - auto deliberately retains the provider baseline
        if strategy == "require":
            raise
        fallback = {**plan}
        fallback["segment_strategy"] = "auto"
        fallback["segment_aware_summary"] = {
            "target_count": 0,
            "composed_target_count": 0,
            "fallback_target_count": 0,
            "error": type(exc).__name__,
        }
        if proposal_mode:
            fallback = _mark_route_proposed(fallback, include_elevation=include_elevation)
        for candidate in fallback.get("candidates") or []:
            targets = candidate.get("stages") or [candidate]
            for target in targets:
                target["warnings"] = [
                    *list(target.get("warnings") or []),
                    f"Strava 路段规划不可用，保留地图基准路线：{type(exc).__name__}",
                ]
        return fallback


def _request_segment_selection(payload: dict[str, Any]) -> dict[str, Any]:
    response = AnthropicMessagesClient().create_message(
        system=(
            "You select a small set of real Strava cycling Segments for already resolved route anchors. "
            "Return JSON only with schema {\"proposals\":[{\"target_id\":str,\"name\":str,"
            "\"reason\":str,\"segments\":[{\"segment_id\":int,"
            "\"direction\":\"auto|forward|reverse\"}]}]}. "
            "Never invent ids. Return at most 2 proposals per target and at most 2 coherent segments per proposal. "
            "Each proposal is a separate route alternative; do not put every relevant segment into one route. "
            "Prefer high route_overlap_ratio, low "
            "distance_to_route_km, coherent route_position_ratio, and the user's stated preferences. "
            "It is valid to return an empty segment list when evidence is weak."
        ),
        user=json.dumps(payload, ensure_ascii=False, default=str),
        max_tokens=900,
        temperature=0.2,
    )
    return _json_object(extract_text(response))


def _mark_route_proposed(plan: dict[str, Any], *, include_elevation: bool) -> dict[str, Any]:
    candidates = []
    for candidate in plan.get("candidates") or []:
        if isinstance(candidate, dict):
            candidates.append({**candidate, "candidate_kind": candidate.get("candidate_kind") or "baseline"})
    return {
        **plan,
        "candidates": candidates,
        "planning": {
            **(plan.get("planning") if isinstance(plan.get("planning"), dict) else {}),
            "status": "awaiting_selection",
            "confirmed_candidate_id": None,
            "include_elevation": bool(include_elevation),
        },
    }


def _confirm_route_candidate(
    plan: dict[str, Any], candidate_id: str, *, include_elevation: bool,
) -> dict[str, Any]:
    config = load_config()
    candidates = []
    for candidate in plan.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        updated = dict(candidate)
        if str(candidate.get("candidate_id") or "") == candidate_id and include_elevation and not candidate.get("elevation"):
            geometry = candidate.get("geometry") if isinstance(candidate.get("geometry"), dict) else {}
            coordinates = geometry.get("coordinates") if isinstance(geometry.get("coordinates"), list) else []
            try:
                updated["elevation"] = _elevation_profile(
                    coordinates, float(candidate.get("distance_m") or 0), config,
                )
            except (RuntimeError, ValueError) as exc:
                updated["warnings"] = [*(candidate.get("warnings") or []), f"海拔请求失败：{exc}"]
        candidates.append(updated)
    return {
        **plan,
        "active_candidate_id": candidate_id,
        "candidates": candidates,
        "planning": {
            **(plan.get("planning") if isinstance(plan.get("planning"), dict) else {}),
            "status": "confirmed",
            "confirmed_candidate_id": candidate_id,
        },
    }


def _json_object(text: str) -> dict[str, Any]:
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("route selector did not return JSON")
        value = json.loads(cleaned[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError("route selector must return a JSON object")
    return value


def _training_load(context: AgentContext) -> dict[str, Any] | None:
    last = context.last_tool_result
    result = last.get("result") if isinstance(last, dict) else None
    if isinstance(result, dict) and result.get("kind") == "training_load_summary":
        return result
    return None


def _latest_user_message(context: AgentContext) -> str:
    for message in reversed(context.messages):
        if isinstance(message, dict) and message.get("role") == "user":
            return str(message.get("content") or "")
    return ""


HANDLERS = {
    "create_route_plan": create_route_plan,
    "create_itinerary_plan": create_itinerary_plan,
    "update_route_plan": update_route_plan,
    "get_route_plan": get_route_plan,
    "explore_route_segments": explore_route_segments,
}
