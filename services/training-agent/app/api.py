"""FastAPI Web API for the SQLite-backed activity catalogue.

注意:所有接口是同步的,LLM 分析接口会阻塞事件循环(30-120s).
后续应改为 async + run_in_executor.
"""

from __future__ import annotations

import hmac
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent.main_agent.loop import run_tool_loop
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
from domain.analysis.artifacts import get_analysis_summary, summary_schema_version
from operations.activity.service import (
    analyze_fit_document,
    check_garmin_connection,
    sync_garmin_activities_tool,
)
from integrations.garmin import DEFAULT_OUTPUT_DIR
from storage.repositories.activity import ActivityStore, file_content_key
from storage.repositories.route import RoutePlanStore
from services.route.single_day import compact_route_plan
from operations.activity.strava import upload_activity_to_strava
from fit.parser import parse_fit


app = FastAPI(title="Personal FIT Agent API")
chat_sessions = ChatSessionStore()
STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class DownloadGarminRequest(BaseModel):
    count: int | None = None
    force_download: bool = False


class AnalyzeFitRequest(BaseModel):
    path: str
    history: bool = False
    force: bool = False


class UploadStravaRequest(BaseModel):
    activity_key: str
    title: str | None = None
    wait: bool = True
    force: bool = False


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


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/dashboard/status")
def dashboard_status_endpoint(request: Request) -> dict[str, Any]:
    _require_api_access(request)
    config = load_config()
    output_dir = _fit_output_dir(config)
    return {
        "garmin_configured": bool(config.get("garmin_username") and config.get("garmin_password")),
        "strava_configured": bool(
            config.get("strava", {}).get("access_token")
            or (
                config.get("strava", {}).get("client_id")
                and config.get("strava", {}).get("client_secret")
                and config.get("strava", {}).get("refresh_token")
            )
        ),
        "fit_dir": str(output_dir),
        "fit_count": len(_fit_files(output_dir)),
    }


@app.post("/api/garmin/connect")
def garmin_connect_endpoint(request: Request) -> dict[str, Any]:
    _require_api_access(request)
    return check_garmin_connection()


@app.post("/api/garmin/download")
def garmin_download_endpoint(request: DownloadGarminRequest, http_request: Request) -> dict[str, Any]:
    _require_api_access(http_request)
    config = load_config()
    output_dir = _fit_output_dir(config)
    count = request.count or int(cfg_get(config, "download_count", 5))

    result = sync_garmin_activities_tool(count=count, force_download=request.force_download)
    results = [
        {**item, "status": "downloaded"}
        for item in result.get("downloaded_items") or []
    ]
    results.extend(
        {**item, "status": "skipped_existing"}
        for item in result.get("skipped_items") or []
    )
    results.extend(
        {**item, "status": "failed"}
        for item in result.get("failed_items") or []
    )

    return {
        "status": "partial" if result.get("failed") or result.get("index_errors") else "ok",
        "fit_dir": result.get("fit_dir") or str(output_dir),
        "count": len(results),
        "downloaded": int(result.get("downloaded") or 0),
        "skipped": int(result.get("skipped") or 0),
        "failed": int(result.get("failed") or 0),
        "index_errors": result.get("index_errors") or [],
        "results": results,
    }


@app.get("/api/fit-files")
def fit_files_endpoint(request: Request) -> dict[str, Any]:
    _require_api_access(request)
    config = load_config()
    output_dir = _fit_output_dir(config)
    files = [_fit_file_info(path) for path in _fit_files(output_dir)]
    files.sort(key=_activity_sort_key, reverse=True)
    return {"fit_dir": str(output_dir), "files": files}


@app.post("/api/fit-files/analyze")
def analyze_fit_endpoint(request: AnalyzeFitRequest, http_request: Request) -> dict[str, Any]:
    _require_api_access(http_request)
    config = load_config()
    fit_path = _require_managed_path(
        request.path,
        allowed_root=_fit_output_dir(config),
        suffix=".fit",
        label="FIT file",
    )
    return analyze_fit_document(fit_path, use_history=request.history, force=request.force)


@app.get("/api/summary")
def summary_endpoint(activity_key: str, request: Request):
    """Return the current report body by stable activity key."""
    _require_api_access(request)
    data = ActivityStore().get_report(activity_key)
    if data is None:
        raise HTTPException(status_code=404, detail="Activity report does not exist.")
    return {"activity_key": activity_key, "markdown_report": data.get("markdown_report", "")}


@app.post("/api/strava/upload")
def strava_upload_endpoint(request: UploadStravaRequest, http_request: Request) -> dict[str, Any]:
    _require_api_access(http_request)
    return upload_activity_to_strava(
        request.activity_key,
        title=request.title,
        wait=request.wait,
        force=request.force,
    )


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


def _fit_output_dir(config: dict[str, Any]) -> Path:
    from settings import resolve_project_path

    return resolve_project_path(cfg_get(config, "output_dir", DEFAULT_OUTPUT_DIR))


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


def _fit_files(output_dir: Path) -> list[Path]:
    if not output_dir.exists():
        return []
    return sorted(output_dir.glob("*.fit"), key=lambda path: path.name)


def _fit_file_info(path: Path) -> dict[str, Any]:
    activity_key = file_content_key(path)
    store = ActivityStore()
    summary = store.get_report(activity_key)
    info: dict[str, Any] = {
        "activity_key": activity_key,
        "name": path.name,
        "path": str(path),
        "size_bytes": path.stat().st_size,
        "mtime": path.stat().st_mtime,
        "has_summary": summary is not None,
    }

    if summary is not None:
        try:
            info["fit_summary"] = summary.get("fit_summary")
            info["analysis_summary"] = get_analysis_summary(summary)
            info["summary_schema_version"] = summary_schema_version(summary)
            info["display_summary"] = _display_summary_from_analysis(summary)
            info["strava_summary"] = summary.get("strava_summary")
            info["strava_summary_tone"] = summary.get("strava_summary_tone")
        except (TypeError, ValueError):
            info["summary_error"] = "Failed to read activity report"
    else:
        try:
            fit_summary = parse_fit(path).get("summary")
            info["fit_summary"] = fit_summary
            info["display_summary"] = _display_summary_from_fit(fit_summary)
        except Exception as exc:
            info["parse_error"] = str(exc)

    return info


def _display_summary_from_analysis(summary: dict[str, Any]) -> dict[str, Any]:
    fit_summary = summary.get("fit_summary") or {}
    analysis_summary = get_analysis_summary(summary)
    activity_metrics = summary.get("activity_metrics") if isinstance(summary.get("activity_metrics"), dict) else {}
    scale = activity_metrics.get("scale") if isinstance(activity_metrics.get("scale"), dict) else {}
    return {
        "start_time": (
            fit_summary.get("start_time_local")
            or fit_summary.get("start_time")
        ),
        "sport_type": fit_summary.get("sport_type"),
        "sub_sport": fit_summary.get("sub_sport"),
        "distance_km": scale.get("distance_km") or _meters_to_km(fit_summary.get("distance_m")),
        "duration_min": scale.get("duration_min") or _seconds_to_min(fit_summary.get("duration_s")),
        "summary_label": analysis_summary.get("summary_label") or "",
        "main_stimulus": analysis_summary.get("main_stimulus") or "",
        "load_label": analysis_summary.get("load_label") or "",
        "brief": analysis_summary.get("brief") or "",
    }


def _display_summary_from_fit(fit_summary: dict[str, Any] | None) -> dict[str, Any]:
    fit_summary = fit_summary or {}
    return {
        "start_time": fit_summary.get("start_time_local") or fit_summary.get("start_time"),
        "sport_type": fit_summary.get("sport_type"),
        "sub_sport": fit_summary.get("sub_sport"),
        "distance_km": _meters_to_km(fit_summary.get("distance_m")),
        "duration_min": _seconds_to_min(fit_summary.get("duration_s")),
        "summary_label": "",
        "main_stimulus": "",
        "load_label": "",
        "brief": "",
    }


def _activity_sort_key(item: dict[str, Any]) -> float | str:
    display = item.get("display_summary") or {}
    fit_summary = item.get("fit_summary") or {}
    value = display.get("start_time") or fit_summary.get("start_time")
    parsed = _parse_datetime(value)
    if parsed:
        return parsed.timestamp()
    return str(value or item.get("name") or "")


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value)
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _meters_to_km(value: Any) -> float | None:
    try:
        return round(float(value) / 1000, 2)
    except (TypeError, ValueError):
        return None


def _seconds_to_min(value: Any) -> float | None:
    try:
        return round(float(value) / 60, 1)
    except (TypeError, ValueError):
        return None
