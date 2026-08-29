"""Atomic confirmation of an Agent route plan into a Rider saved-route asset."""

from __future__ import annotations

from copy import deepcopy
from math import isclose
from pathlib import Path
from typing import Any

from services.route.view import build_route_plan_view
from storage.database import connect_database
from storage.repositories.route import RoutePlanStore
from storage.repositories.saved_route import SavedRouteStore


def confirm_and_save_route(
    *,
    plan_id: str,
    candidate_id: str,
    expected_revision: int,
    workspace_id: str,
    saved_route: dict[str, Any],
    database: str | Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Confirm one candidate and persist its Rider runtime route atomically.

    The browser constructs the runtime sampling used by the simulator. Python
    keeps the upstream-provider route chosen by the user and validates only
    transaction identity plus distance before writing both aggregates through
    one SQLite connection. Any persistence failure rolls both changes back.
    """
    normalized_plan_id = str(plan_id or "").strip()
    normalized_candidate_id = str(candidate_id or "").strip()
    normalized_workspace_id = str(workspace_id or "").strip()
    if not normalized_plan_id or not normalized_candidate_id or not normalized_workspace_id:
        raise ValueError("plan_id, candidate_id and workspace_id are required")
    if not isinstance(saved_route, dict):
        raise ValueError("saved_route is required for confirm")

    plan_store = RoutePlanStore(database)
    saved_route_store = SavedRouteStore(database)
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        plan = plan_store.get(normalized_plan_id, connection=connection)
        if not plan:
            raise ValueError("route plan does not exist")
        if str(plan.get("workspace_id") or "") != normalized_workspace_id:
            raise PermissionError("route plan does not belong to this chat session")
        candidate = _candidate_view(plan, normalized_candidate_id)
        _validate_saved_route_snapshot(
            saved_route,
            plan_id=normalized_plan_id,
            candidate_id=normalized_candidate_id,
            candidate=candidate,
        )
        confirmed = _mark_confirmed(plan, normalized_candidate_id)
        stored_plan = plan_store.save(
            confirmed,
            expected_revision=expected_revision,
            connection=connection,
        )
        authoritative_route = _with_confirmed_metadata(
            saved_route,
            stored_plan=stored_plan,
            candidate=candidate,
        )
        stored_route = saved_route_store.save_route(authoritative_route, connection=connection)
    return stored_plan, stored_route


def _candidate_view(plan: dict[str, Any], candidate_id: str) -> dict[str, Any]:
    view = build_route_plan_view(plan)
    if str(view.get("schedule_type") or "single_day") != "single_day":
        raise ValueError("only single-day route candidates can be saved for Rider runtime")
    candidate = next(
        (
            item for item in view.get("candidates") or []
            if isinstance(item, dict) and str(item.get("candidate_id") or "") == candidate_id
        ),
        None,
    )
    if not candidate:
        raise ValueError("route candidate does not exist")
    if candidate.get("stages"):
        raise ValueError("staged route candidates cannot be saved as one Rider runtime route")
    geometry = candidate.get("geometry") if isinstance(candidate.get("geometry"), dict) else {}
    if len(geometry.get("coordinates") or []) < 2:
        raise ValueError("route candidate has no usable geometry")
    return candidate


def _validate_saved_route_snapshot(
    saved_route: dict[str, Any],
    *,
    plan_id: str,
    candidate_id: str,
    candidate: dict[str, Any],
) -> None:
    route = saved_route.get("route")
    if not isinstance(route, dict):
        raise ValueError("saved_route.route is required")
    if str(saved_route.get("source") or "") != "agent":
        raise ValueError("confirmed Agent routes must use source=agent")
    identifiers = {
        str(saved_route.get("agentPlanId") or ""),
        str(route.get("agentPlanId") or ""),
    }
    if identifiers != {plan_id}:
        raise ValueError("saved route plan identity does not match the confirmed plan")
    candidate_identifiers = {
        str(saved_route.get("agentCandidateId") or ""),
        str(route.get("agentCandidateId") or ""),
    }
    if candidate_identifiers != {candidate_id}:
        raise ValueError("saved route candidate identity does not match the confirmed candidate")
    expected_name = str(candidate.get("name") or "")
    if (
        str(saved_route.get("name") or "") != expected_name
        or str(route.get("name") or "") != expected_name
    ):
        raise ValueError("saved route name does not match the confirmed candidate")

    expected_distance = float(candidate.get("distance_m") or 0)
    actual_distance = _number(route.get("totalDistanceMeters"))
    if expected_distance <= 0 or actual_distance <= 0 or not isclose(
        actual_distance,
        expected_distance,
        rel_tol=0.001,
        abs_tol=1.0,
    ):
        raise ValueError("saved route distance does not match the confirmed candidate")


def _with_confirmed_metadata(
    saved_route: dict[str, Any],
    *,
    stored_plan: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    result = deepcopy(saved_route)
    metadata = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
    authoritative_metadata = {
        **metadata,
        "provider": candidate.get("provider"),
        "stravaSegments": ", ".join(
            str(item.get("segment_id"))
            for item in candidate.get("segment_sequence") or []
            if isinstance(item, dict) and item.get("segment_id")
        ),
        "planningStatus": "confirmed",
        "revision": int(stored_plan.get("revision") or 0),
    }
    result["metadata"] = authoritative_metadata
    route = deepcopy(result.get("route") or {})
    route["agentMetadata"] = authoritative_metadata
    result["route"] = route
    return result


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _mark_confirmed(plan: dict[str, Any], candidate_id: str) -> dict[str, Any]:
    planning = plan.get("planning") if isinstance(plan.get("planning"), dict) else {}
    return {
        **plan,
        "active_candidate_id": candidate_id,
        "planning": {
            **planning,
            "status": "confirmed",
            "confirmed_candidate_id": candidate_id,
        },
    }
