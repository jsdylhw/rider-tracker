"""Web API security and managed-path regression tests."""

from __future__ import annotations

import importlib

from fastapi.testclient import TestClient
from storage.repositories.route import RoutePlanStore


def _prepare_api(tmp_path, monkeypatch, *, web_api_token: str = "", llm_configured: bool = True):
    monkeypatch.chdir(tmp_path)
    fit_dir = tmp_path / "fits"
    fit_dir.mkdir()
    config = {
        "output_dir": str(fit_dir),
        "agent": ({
            "enabled": "auto",
            "base_url": "https://llm.example.test",
            "api_key": "test-key",
            "model": "test-model",
        } if llm_configured else {"enabled": "auto"}),
    }
    if web_api_token:
        config["web_api_token"] = web_api_token
    api = importlib.import_module("app.api")
    monkeypatch.setattr(api, "load_config", lambda: config)
    api.chat_sessions.clear()
    return api, TestClient(api.app), fit_dir


def test_service_root_returns_metadata_instead_of_a_second_web_ui(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch)

    response = client.get("/")

    assert response.status_code == 200
    assert response.json() == {"service": "rider-training-backend", "status": "ok"}
    assert client.get("/static/app.js").status_code == 404


def test_health_reports_backend_available_when_llm_is_not_configured(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch, llm_configured=False)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["backend"] == "available"
    assert response.json()["llm"] == "not_configured"
    assert response.json()["capabilities"]["fit_ingestion"] is True
    assert response.json()["capabilities"]["ai_route_planning"] is False


def test_llm_endpoints_return_agent_unavailable_without_disabling_backend(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch, llm_configured=False)

    response = client.post("/api/chat", json={
        "session_id": "no-llm", "request_id": "request-1", "message": "分析活动",
    })

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "agent_unavailable"
    assert response.json()["detail"]["capability"] == "activity_analysis"


def test_legacy_web_ui_routes_are_not_exposed(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch)

    calls = [
        ("get", "/api/dashboard/status"),
        ("post", "/api/garmin/connect"),
        ("post", "/api/garmin/download"),
        ("get", "/api/fit-files"),
        ("post", "/api/fit-files/analyze"),
        ("get", "/api/summary"),
        ("post", "/api/strava/upload"),
    ]

    for method, path in calls:
        assert getattr(client, method)(path).status_code == 404


def test_current_internal_api_surface_is_explicit(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch)
    paths = {path for path in client.get("/openapi.json").json()["paths"] if path.startswith("/api/")}

    assert paths == {
        "/api/activities/ingest-fit",
        "/api/activities/{activity_id}/detail",
        "/api/athlete-profile",
        "/api/chat",
        "/api/route-narrations/prepare",
        "/api/route-plans/command",
        "/api/route-plans/select",
        "/api/strava/auth-url",
        "/api/strava/config",
        "/api/strava/connection",
        "/api/strava/exchange-code",
        "/api/strava/upload-activity",
        "/api/strava/upload-status/{upload_id}",
    }


def test_route_narration_endpoint_runs_independent_agent(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(
        api,
        "run_route_narration_agent",
        lambda request: calls.append(request) or {"schema_version": "route_narration_plan.v1"},
    )
    response = client.post("/api/route-narrations/prepare", json={
        "route_fingerprint": "route_1234abcd",
        "route_name": "测试路线",
        "total_distance_m": 10000,
        "estimated_duration_min": 30,
        "samples": [
            {"sample_id": "sample_1", "route_distance_m": 0, "latitude": 30, "longitude": 120},
            {"sample_id": "sample_2", "route_distance_m": 10000, "latitude": 30.1, "longitude": 120.1},
        ],
    })

    assert response.status_code == 200
    assert response.json()["schema_version"] == "route_narration_plan.v1"
    assert calls[0]["route_fingerprint"] == "route_1234abcd"


def test_ingest_fit_uses_deterministic_managed_file_service(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    rider_root = tmp_path / "rider"
    fit = rider_root / "data" / "files" / "fit" / "manual.fit"
    fit.parent.mkdir(parents=True)
    fit.write_bytes(b"fit")
    monkeypatch.setattr(api, "project_root", lambda: rider_root)
    calls = []
    monkeypatch.setattr(
        api,
        "ingest_fit_activity",
        lambda path, **kwargs: calls.append((path, kwargs)) or {
            "schema_version": "fit_ingestion.v1", "status": "completed",
        },
    )

    response = client.post("/api/activities/ingest-fit", json={
        "path": "data/files/fit/manual.fit",
        "activity_id": "fit-manual",
        "source": "fit-import",
        "max_points": 500,
    })

    assert response.status_code == 200
    assert calls == [(fit, {
        "activity_key": "fit-manual",
        "source": "fit-import",
        "source_activity_id": None,
        "name": None,
        "max_points": 500,
    })]

    outside = tmp_path / "outside.fit"
    outside.write_bytes(b"fit")
    denied = client.post("/api/activities/ingest-fit", json={
        "path": str(outside),
        "activity_id": "outside-fit",
    })
    assert denied.status_code == 403
    assert len(calls) == 1


def test_activity_detail_endpoint_returns_cached_contract(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    monkeypatch.setattr(
        api, "get_activity_detail",
        lambda key, max_points=700: {
            "schema_version": "activity_detail.v1",
            "activity": {"activity_key": key},
            "series": {"records": [], "sample_count": 0},
        },
    )

    response = client.get("/api/activities/a1/detail?max_points=500")

    assert response.status_code == 200
    assert response.json()["activity"]["activity_key"] == "a1"


def test_athlete_profile_api_returns_and_updates_rider_settings(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    saved = []
    profile = {"cycling": {"ftp_w": 260}, "shared": {"max_heart_rate": 200}}
    monkeypatch.setattr(api, "get_athlete_profile", lambda: profile)
    monkeypatch.setattr(
        api,
        "update_athlete_profile",
        lambda value: saved.append(value) or {
            "cycling": {"ftp_w": value.get("ftp")},
            "shared": {"weight_kg": value.get("mass")},
        },
    )

    current = client.get("/api/athlete-profile")
    updated = client.put("/api/athlete-profile", json={"profile": {"ftp": 275, "mass": 80}})

    assert current.status_code == 200
    assert current.json()["rider_settings"]["ftp"] == 260
    assert updated.status_code == 200
    assert saved == [{"ftp": 275, "mass": 80}]


def test_strava_owner_endpoints_delegate_to_python_sink(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    monkeypatch.setattr(api, "load_config", lambda: {
        "strava": {"client_id": "123", "client_secret": "secret"}
    })

    class FakeSink:
        def __init__(self, require_access_token=True):
            self.require_access_token = require_access_token

        def connection_status(self):
            return {"connected": True, "configured": True, "expires_at": 123}

        def build_authorize_url(self, **kwargs):
            return f"https://strava.test/auth?state={kwargs['state']}"

        def exchange_authorization_code(self, code):
            return {"access_token": "token", "athlete": {"id": 1}, "expires_at": 456}

    monkeypatch.setattr(api, "StravaSink", FakeSink)

    config = client.get("/api/strava/config")
    connection = client.get("/api/strava/connection")
    auth = client.post("/api/strava/auth-url", json={
        "redirect_uri": "http://localhost/callback",
        "state": "state-1",
    })
    exchange = client.post("/api/strava/exchange-code", json={"code": "code-1"})

    assert config.json()["configured"] is True
    assert connection.json()["connected"] is True
    assert auth.json()["auth_url"].endswith("state=state-1")
    assert exchange.json()["athlete"]["id"] == 1


def test_strava_activity_upload_and_status_delegate_to_owner_service(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    uploads = []
    monkeypatch.setattr(
        api,
        "upload_stored_activity_fit",
        lambda activity_key, **kwargs: uploads.append((activity_key, kwargs)) or {
            "status": "processing", "upload_id": "upload-7",
        },
    )
    monkeypatch.setattr(
        api,
        "get_strava_upload_status",
        lambda upload_id: {"status": "completed", "upload_id": upload_id, "activity_id": "strava-9"},
    )

    uploaded = client.post("/api/strava/upload-activity", json={
        "activity_key": "fit-7",
        "title": "晨骑",
        "trainer": True,
    })
    status = client.get("/api/strava/upload-status/upload-7")

    assert uploaded.status_code == 200
    assert uploaded.json()["upload_id"] == "upload-7"
    assert uploads == [("fit-7", {
        "title": "晨骑",
        "description": None,
        "trainer": True,
        "commute": False,
        "sport_type": None,
    })]
    assert status.json() == {"status": "completed", "upload_id": "upload-7", "activity_id": "strava-9"}


def test_route_candidate_click_persists_preview_without_archiving_chat_turn(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    session = api.chat_sessions.get_or_create("route-session")
    workspace_id = str(session.context.workspace_id)
    stored = RoutePlanStore().save({
        "schema_version": "route_plan.v1",
        "plan_id": "route-click",
        "workspace_id": workspace_id,
        "active_candidate_id": "candidate_1",
        "candidates": [
            {"candidate_id": "candidate_1", "name": "一"},
            {"candidate_id": "candidate_2", "name": "二"},
        ],
    })

    response = client.post("/api/route-plans/select", json={
        "session_id": "route-session",
        "request_id": "select-1",
        "plan_id": stored["plan_id"],
        "candidate_id": "candidate_2",
        "expected_revision": stored["revision"],
    })

    assert response.status_code == 200
    assert response.json()["active_candidate_id"] == "candidate_2"
    assert RoutePlanStore().get("route-click")["active_candidate_id"] == "candidate_2"


def test_route_command_get_and_confirm_return_full_presentations(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    session = api.chat_sessions.get_or_create("route-command")
    stored = RoutePlanStore().save({
        "schema_version": "route_plan.v1",
        "plan_id": "route-command-plan",
        "workspace_id": str(session.context.workspace_id),
        "title": "虚拟路线",
        "schedule_type": "single_day",
        "active_candidate_id": "candidate_1",
        "planning": {"status": "awaiting_selection", "include_elevation": False},
        "candidates": [{
            "candidate_id": "candidate_1",
            "name": "候选一",
            "distance_km": 20,
            "duration_min": 60,
            "provider": "Google",
            "travel_mode": "BICYCLE",
            "geometry": {
                "type": "LineString",
                "coordinates": [[121.0, 31.0], [121.1, 31.1]],
            },
            "waypoints": [],
        }],
    })

    current = client.post("/api/route-plans/command", json={
        "session_id": "route-command",
        "request_id": "route-get-1",
        "plan_id": stored["plan_id"],
        "operation": "get",
    })
    confirmed = client.post("/api/route-plans/command", json={
        "session_id": "route-command",
        "request_id": "route-confirm-1",
        "plan_id": stored["plan_id"],
        "candidate_id": "candidate_1",
        "operation": "confirm",
        "expected_revision": stored["revision"],
    })

    assert current.status_code == 200
    assert {item["type"] for item in current.json()["presentations"]} == {"table", "route_map"}
    assert current.json()["route_plan"]["schema_version"] == "route_plan_view.v1"
    assert current.json()["route_plan"]["plan_id"] == stored["plan_id"]
    assert confirmed.status_code == 200
    assert confirmed.json()["result"]["planning"]["status"] == "confirmed"
    assert confirmed.json()["route_plan"]["planning_status"] == "confirmed"
    assert RoutePlanStore().get(stored["plan_id"])["planning"]["confirmed_candidate_id"] == "candidate_1"


def test_route_command_rejects_unsupported_operation(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch)
    response = client.post("/api/route-plans/command", json={
        "session_id": "route-command",
        "request_id": "route-invalid-1",
        "operation": "delete_everything",
    })
    assert response.status_code == 400


def test_route_command_is_idempotent_and_rejects_stale_revision(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    session = api.chat_sessions.get_or_create("route-cas")
    stored = RoutePlanStore().save({
        "plan_id": "route-cas-plan",
        "workspace_id": str(session.context.workspace_id),
        "active_candidate_id": "candidate-1",
        "planning": {"status": "awaiting_selection"},
        "candidates": [{"candidate_id": "candidate-1", "name": "候选"}],
    })
    request = {
        "session_id": "route-cas",
        "request_id": "confirm-once",
        "plan_id": stored["plan_id"],
        "candidate_id": "candidate-1",
        "operation": "confirm",
        "expected_revision": stored["revision"],
    }

    first = client.post("/api/route-plans/command", json=request)
    replay = client.post("/api/route-plans/command", json=request)
    stale = client.post("/api/route-plans/command", json={
        **request,
        "request_id": "stale-confirm",
    })

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert RoutePlanStore().get(stored["plan_id"])["revision"] == stored["revision"] + 1
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "route_revision_conflict"
    assert stale.json()["detail"]["actual_revision"] == stored["revision"] + 1


def test_route_command_targets_an_explicit_plan_without_mutating_another_plan(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    session = api.chat_sessions.get_or_create("route-multiple-plans")
    workspace_id = str(session.context.workspace_id)
    first = RoutePlanStore().save({
        "plan_id": "route-first",
        "workspace_id": workspace_id,
        "active_candidate_id": "candidate-first",
        "planning": {"status": "awaiting_selection"},
        "candidates": [{"candidate_id": "candidate-first", "name": "第一条"}],
    })
    second = RoutePlanStore().save({
        "plan_id": "route-second",
        "workspace_id": workspace_id,
        "active_candidate_id": "candidate-second",
        "planning": {"status": "awaiting_selection"},
        "candidates": [{"candidate_id": "candidate-second", "name": "第二条"}],
    })

    response = client.post("/api/route-plans/command", json={
        "session_id": "route-multiple-plans",
        "request_id": "confirm-first-plan",
        "plan_id": first["plan_id"],
        "candidate_id": "candidate-first",
        "operation": "confirm",
        "expected_revision": first["revision"],
    })

    assert response.status_code == 200
    assert response.json()["route_plan"]["plan_id"] == "route-first"
    assert RoutePlanStore().get("route-first")["planning"]["status"] == "confirmed"
    untouched = RoutePlanStore().get("route-second")
    assert untouched["revision"] == second["revision"]
    assert untouched["planning"]["status"] == "awaiting_selection"


def test_route_command_rejects_request_id_reuse_with_different_payload(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    session = api.chat_sessions.get_or_create("route-replay-conflict")
    stored = RoutePlanStore().save({
        "plan_id": "route-replay-plan",
        "workspace_id": str(session.context.workspace_id),
        "active_candidate_id": "candidate-1",
        "planning": {"status": "awaiting_selection"},
        "candidates": [{"candidate_id": "candidate-1", "name": "候选"}],
    })
    base = {
        "session_id": "route-replay-conflict",
        "request_id": "same-request",
        "plan_id": stored["plan_id"],
        "expected_revision": stored["revision"],
    }

    first = client.post("/api/route-plans/command", json={
        **base, "operation": "confirm", "candidate_id": "candidate-1",
    })
    reused = client.post("/api/route-plans/command", json={
        **base, "operation": "reverse", "candidate_id": "candidate-1",
    })

    assert first.status_code == 200
    assert reused.status_code == 400
    assert "different request payload" in reused.json()["detail"]


def test_chat_reuses_context_and_deduplicates_request_id(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    calls = []

    def fake_run(message, *, context):
        calls.append((message, context))
        context.messages.append({"role": "user", "content": message})
        return {
            "answer": f"answer:{message}",
            "status": "completed",
            "context": context,
            "intent": "chat",
            "skill_id": None,
            "executions": [],
            "presentations": [],
            "current_fit_file": "/private/activity.fit",
        }

    monkeypatch.setattr(api, "run_tool_loop", fake_run)

    first = client.post("/api/chat", json={
        "session_id": "session-1", "request_id": "request-1", "message": "第一轮",
    })
    duplicate = client.post("/api/chat", json={
        "session_id": "session-1", "request_id": "request-1", "message": "第一轮",
    })
    second = client.post("/api/chat", json={
        "session_id": "session-1", "request_id": "request-2", "message": "第二轮",
    })

    assert first.status_code == duplicate.status_code == second.status_code == 200
    assert duplicate.json() == first.json()
    assert [item[0] for item in calls] == ["第一轮", "第二轮"]
    assert calls[0][1] is calls[1][1]
    assert [item["content"] for item in calls[1][1].messages] == ["第一轮", "第二轮"]


def test_chat_rejects_request_id_reuse_with_different_message(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(api, "run_tool_loop", lambda message, *, context: (
        calls.append(message) or {"answer": "ok", "status": "completed", "intent": "chat"}
    ))

    first = client.post("/api/chat", json={
        "session_id": "session-1", "request_id": "request-1", "message": "第一轮",
    })
    conflict = client.post("/api/chat", json={
        "session_id": "session-1", "request_id": "request-1", "message": "另一条消息",
    })

    assert first.status_code == 200
    assert conflict.status_code == 409
    assert calls == ["第一轮"]


def test_chat_applies_route_options_only_for_current_request(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    seen = []

    def run(message, *, context):
        seen.append((message, dict(context.route_request_options)))
        return {"answer": "ok", "status": "completed", "intent": "route_advice"}

    monkeypatch.setattr(api, "run_tool_loop", run)
    first = client.post("/api/chat", json={
        "session_id": "session-1", "request_id": "request-1", "message": "生成虚拟路线",
        "route_options": {"include_elevation": False},
    })
    second = client.post("/api/chat", json={
        "session_id": "session-1", "request_id": "request-2", "message": "普通聊天",
    })

    assert first.status_code == second.status_code == 200
    assert seen == [
        ("生成虚拟路线", {"include_elevation": False}),
        ("普通聊天", {}),
    ]
    assert api.chat_sessions.get_or_create("session-1").context.route_request_options == {}


def test_chat_returns_only_public_execution_and_presentation_fields(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    monkeypatch.setattr(api, "run_tool_loop", lambda message, *, context: {
        "answer": "完成",
        "status": "completed",
        "context": {"secret": True},
        "intent": "training_history",
        "skill_id": "analyze-training-history",
        "executions": [{
            "index": 0,
            "tool": "analyze_training_history",
            "status": "completed",
            "input": {"path": "/private/activity.fit"},
            "result": {"private": "raw"},
            "navigation_before": {"private": True},
        }],
        "presentations": [{
            "schema_version": "presentation.v1",
            "presentation_id": "history-table",
            "type": "table",
            "title": "训练趋势对比",
            "data": {"rows": []},
            "source": {"tool": "analyze_training_history"},
        }],
        "current_fit_file": "/private/activity.fit",
    })

    response = client.post("/api/chat", json={
        "session_id": "session-1", "request_id": "request-1", "message": "最近训练如何",
    })
    body = response.json()

    assert response.status_code == 200
    assert set(body) == {"schema_version", "answer", "status", "intent", "skill_id", "executions", "presentations"}
    assert body["schema_version"] == "agent_turn.v1"
    assert body["executions"] == [{
        "index": 0,
        "tool": "analyze_training_history",
        "status": "completed",
        "message": None,
        "error": None,
    }]
    assert body["presentations"][0]["type"] == "table"
    assert "/private/activity.fit" not in str(body)


def test_chat_uses_existing_api_token_boundary(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch, web_api_token="chat-token")
    monkeypatch.setattr(api, "run_tool_loop", lambda message, *, context: {
        "answer": "ok", "status": "completed", "intent": "chat",
    })
    payload = {"session_id": "session-1", "request_id": "request-1", "message": "hello"}

    assert client.post("/api/chat", json=payload).status_code == 401
    assert client.post(
        "/api/chat", json=payload, headers={"X-API-Token": "chat-token"},
    ).status_code == 200
