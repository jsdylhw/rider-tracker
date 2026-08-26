"""FastAPI Web API for the SQLite-backed activity catalogue.

注意:所有接口是同步的,LLM 分析接口会阻塞事件循环(30-120s).
后续应改为 async + run_in_executor.
"""

from __future__ import annotations

import hmac
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from agent.main_agent.loop import run_tool_loop
from agent.narration import run_route_narration_agent
from agent.runtime.models import public_turn_dict
from agent.runtime.models import ToolExecution
from agent.runtime.presentation_projector import project_presentations
from agent.tools.handlers.route import (
    explore_route_segments_tool,
    get_route_plan_tool,
    update_route_plan_tool,
)
from app.chat_sessions import ChatSessionStore
from settings import cfg_get, load_config
from storage.repositories.route import RoutePlanStore
from services.route.single_day import compact_route_plan
from operations.activity.strava import (
    get_strava_upload_status,
    upload_stored_activity_fit,
)
from integrations.strava import StravaSink
from project_paths import project_root
from services.activity.ingestion import get_activity_detail, ingest_fit_activity
from services.athlete.profile import (
    athlete_profile_response,
    get_athlete_profile,
    update_athlete_profile,
)


app = FastAPI(title="Personal FIT Agent API")
chat_sessions = ChatSessionStore()


class IngestFitRequest(BaseModel):
    path: str
    activity_id: str | None = Field(default=None, min_length=1, max_length=128)
    source: str = Field(default="manual", min_length=1, max_length=64)
    source_activity_id: str | None = Field(default=None, max_length=128)
    name: str | None = Field(default=None, max_length=200)
    max_points: int = Field(default=700, ge=2, le=2000)


class AthleteProfileRequest(BaseModel):
    profile: dict[str, Any]


class StravaAuthorizeRequest(BaseModel):
    redirect_uri: str = Field(min_length=1, max_length=2000)
    scope: str = Field(default="read,activity:read_all,activity:write", max_length=500)
    state: str = Field(min_length=1, max_length=256)


class StravaExchangeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=512)


class StravaStoredUploadRequest(BaseModel):
    activity_key: str = Field(min_length=1, max_length=128)
    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=20_000)
    trainer: bool = False
    commute: bool = False
    sport_type: str | None = Field(default=None, max_length=64)


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    message: str = Field(min_length=1, max_length=20_000)


class SelectRouteCandidateRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    plan_id: str = Field(min_length=1, max_length=128)
    candidate_id: str = Field(min_length=1, max_length=128)


class RoutePlanCommandRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    plan_id: str | None = Field(default=None, max_length=128)
    operation: str = Field(min_length=1, max_length=64)
    candidate_id: str | None = Field(default=None, max_length=128)
    candidate_name: str | None = Field(default=None, max_length=200)
    target_distance_km: float | None = Field(default=None, gt=0)
    segments: list[dict[str, Any]] = Field(default_factory=list, max_length=3)
    corridor_km: float = Field(default=5.0, ge=0.1, le=20)
    max_segments: int = Field(default=12, ge=1, le=20)


class RouteNarrationSample(BaseModel):
    sample_id: str = Field(min_length=1, max_length=64)
    route_distance_m: float = Field(ge=0)
    estimated_elapsed_s: float | None = Field(default=None, ge=0)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    elevation_m: float | None = None
    grade_percent: float | None = None


class RouteNarrationRequest(BaseModel):
    route_fingerprint: str = Field(pattern=r"^route_[a-f0-9]{8}$")
    route_name: str = Field(min_length=1, max_length=200)
    total_distance_m: float = Field(gt=0, le=1_000_000)
    estimated_duration_min: float = Field(gt=0, le=10_000)
    locale: str = Field(default="zh-CN", max_length=16)
    samples: list[RouteNarrationSample] = Field(min_length=2, max_length=64)


@app.get("/")
def service_info() -> dict[str, str]:
    return {"service": "rider-training-backend", "status": "ok"}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/activities/ingest-fit")
def ingest_fit_endpoint(request: IngestFitRequest, http_request: Request) -> dict[str, Any]:
    """Deterministically index a Rider-managed FIT without invoking an LLM."""
    _require_api_access(http_request)
    requested_path = Path(request.path).expanduser()
    fit_path = _require_managed_path(
        requested_path if requested_path.is_absolute() else project_root() / requested_path,
        allowed_root=project_root() / "data" / "files" / "fit",
        suffix=".fit",
        label="FIT file",
    )
    return ingest_fit_activity(
        fit_path,
        activity_key=request.activity_id,
        source=request.source,
        source_activity_id=request.source_activity_id,
        name=request.name,
        max_points=request.max_points,
    )


@app.get("/api/activities/{activity_id}/detail")
def activity_detail_endpoint(activity_id: str, request: Request, max_points: int = 700) -> dict[str, Any]:
    """Return cached canonical series, rebuilding from the immutable FIT when stale."""
    _require_api_access(request)
    if max_points < 2 or max_points > 2000:
        raise HTTPException(status_code=422, detail="max_points must be between 2 and 2000.")
    detail = get_activity_detail(activity_id, max_points=max_points)
    if detail is None:
        raise HTTPException(status_code=404, detail="Activity does not exist.")
    return detail


@app.get("/api/athlete-profile")
def athlete_profile_endpoint(request: Request) -> dict[str, Any]:
    _require_api_access(request)
    return athlete_profile_response(get_athlete_profile())


@app.put("/api/athlete-profile")
def update_athlete_profile_endpoint(
    request: AthleteProfileRequest,
    http_request: Request,
) -> dict[str, Any]:
    _require_api_access(http_request)
    return athlete_profile_response(update_athlete_profile(request.profile))


@app.get("/api/strava/config")
def strava_config_endpoint(request: Request) -> dict[str, Any]:
    _require_api_access(request)
    config = load_config().get("strava") or {}
    return {
        "configured": bool(config.get("client_id") and config.get("client_secret")),
        "source": "config.yaml" if config else "none",
        "token_store": str(config.get("token_store") or "data/strava-tokens.json"),
    }


@app.get("/api/strava/connection")
def strava_connection_endpoint(request: Request) -> dict[str, Any]:
    _require_api_access(request)
    return StravaSink(require_access_token=False).connection_status()


@app.post("/api/strava/auth-url")
def strava_auth_url_endpoint(
    request: StravaAuthorizeRequest,
    http_request: Request,
) -> dict[str, Any]:
    _require_api_access(http_request)
    sink = StravaSink(require_access_token=False)
    return {
        "auth_url": sink.build_authorize_url(
            redirect_uri=request.redirect_uri,
            scope=request.scope,
            approval_prompt="force",
            state=request.state,
        ),
    }


@app.post("/api/strava/exchange-code")
def strava_exchange_code_endpoint(
    request: StravaExchangeRequest,
    http_request: Request,
) -> dict[str, Any]:
    _require_api_access(http_request)
    result = StravaSink(require_access_token=False).exchange_authorization_code(request.code)
    return {
        "connected": bool(result.get("access_token")),
        "athlete": result.get("athlete"),
        "expires_at": result.get("expires_at"),
    }


@app.post("/api/strava/upload-activity")
def strava_upload_activity_endpoint(
    request: StravaStoredUploadRequest,
    http_request: Request,
) -> dict[str, Any]:
    _require_api_access(http_request)
    try:
        return upload_stored_activity_fit(
            request.activity_key,
            title=request.title,
            description=request.description,
            trainer=request.trainer,
            commute=request.commute,
            sport_type=request.sport_type,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/strava/upload-status/{upload_id}")
def strava_upload_status_endpoint(upload_id: str, request: Request) -> dict[str, Any]:
    _require_api_access(request)
    return get_strava_upload_status(upload_id)


@app.post("/api/chat")
def chat_endpoint(request: ChatRequest, http_request: Request) -> dict[str, Any]:
    """Run one serialized, idempotent turn in a durable chat session."""
    _require_api_access(http_request)
    session = chat_sessions.get_or_create(request.session_id)
    with session.lock:
        try:
            cached = session.cached_response(request.request_id, request.message)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if cached is not None:
            return cached
        result = run_tool_loop(request.message, context=session.context)
        response = public_turn_dict(result)
        session.cache_response(request.request_id, request.message, response)
        return response


@app.post("/api/route-narrations/prepare")
def prepare_route_narration_endpoint(
    request: RouteNarrationRequest,
    http_request: Request,
) -> dict[str, Any]:
    """Run one independent RouteNarrationAgent session for a route snapshot."""
    _require_api_access(http_request)
    return run_route_narration_agent(request.model_dump())


@app.post("/api/route-plans/select")
def select_route_candidate_endpoint(
    request: SelectRouteCandidateRequest,
    http_request: Request,
) -> dict[str, Any]:
    """Persist a deterministic preview selection without spending an LLM turn."""
    _require_api_access(http_request)
    session = chat_sessions.get_or_create(request.session_id)
    with session.lock:
        store = RoutePlanStore()
        plan = store.get(request.plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Route plan does not exist.")
        workspace_id = str(session.context.workspace_id or session.context.session_id)
        if str(plan.get("workspace_id") or "") != workspace_id:
            raise HTTPException(status_code=403, detail="Route plan does not belong to this chat session.")
        valid_ids = {
            str(item.get("candidate_id") or "")
            for item in plan.get("candidates") or [] if isinstance(item, dict)
        }
        if request.candidate_id not in valid_ids:
            raise HTTPException(status_code=404, detail="Route candidate does not exist.")
        stored = store.save({**plan, "active_candidate_id": request.candidate_id}, archive=False)
        return compact_route_plan(stored)


@app.post("/api/route-plans/command")
def route_plan_command_endpoint(
    request: RoutePlanCommandRequest,
    http_request: Request,
) -> dict[str, Any]:
    """Run a deterministic, allowlisted route operation for a durable session."""
    _require_api_access(http_request)
    session = chat_sessions.get_or_create(request.session_id)
    with session.lock:
        try:
            return _run_route_plan_command(session.context, request)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


def _run_route_plan_command(context: Any, request: RoutePlanCommandRequest) -> dict[str, Any]:
    args: dict[str, Any] = {
        "plan_id": request.plan_id or "",
        "candidate_id": request.candidate_id or "",
    }
    operation = request.operation.strip().lower()
    if operation == "get":
        primary = get_route_plan_tool(context, args=args)
    elif operation == "explore_segments":
        primary = explore_route_segments_tool(context, args={
            **args,
            "corridor_km": request.corridor_km,
            "max_segments": request.max_segments,
        })
    else:
        mapped = {
            "select": "select_candidate",
            "confirm": "confirm_candidate",
            "reverse": "reverse_candidate",
            "undo": "undo",
            "compose_segments": "compose_segments",
        }.get(operation)
        if not mapped:
            raise HTTPException(status_code=400, detail="Unsupported route operation.")
        if mapped == "compose_segments" and not request.segments:
            raise HTTPException(status_code=400, detail="segments are required for compose_segments.")
        primary = update_route_plan_tool(context, args={
            **args,
            "operation": mapped,
            "include_elevation": False,
            "candidate_name": request.candidate_name or "",
            "target_distance_km": request.target_distance_km,
            "segments": request.segments,
        })
    plan_result = get_route_plan_tool(context, args={"plan_id": request.plan_id or ""})
    presentations = project_presentations([ToolExecution(
        index=0,
        tool="get_route_plan",
        result=plan_result,
    )])
    return {
        "answer": primary.get("answer") or "",
        "result": plan_result.get("result") or {},
        "presentations": [item.to_dict() for item in presentations],
    }


def _require_api_access(request: Request) -> None:
    """Keep the local control plane local unless a configured token is supplied.

    A configured token is required even from localhost. Without it, only a
    loopback client may call `/api/*`; this prevents an accidental `--host
    0.0.0.0` deployment from exposing Garmin, LLM, and Strava capabilities.
    """
    configured_token = str(cfg_get(load_config(), "web_api_token", "") or "")
    supplied_token = request.headers.get("X-API-Token", "")
    if configured_token:
        if hmac.compare_digest(supplied_token, configured_token):
            return
        raise HTTPException(status_code=401, detail="Valid X-API-Token is required.")

    client_host = request.client.host if request.client else ""
    if client_host in {"127.0.0.1", "::1", "localhost", "testclient"}:
        return
    raise HTTPException(
        status_code=401,
        detail="Web API is local-only. Configure web_api_token for remote access.",
    )


def _require_managed_path(
    value: str,
    *,
    allowed_root: Path,
    suffix: str,
    label: str,
) -> Path:
    root = allowed_root.expanduser().resolve()
    candidate = Path(value).expanduser().resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=f"{label} must be inside {root}.") from exc
    if not candidate.name.lower().endswith(suffix):
        raise HTTPException(status_code=422, detail=f"{label} must end with {suffix}.")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"{label} does not exist.")
    return candidate
