"""Web API security and managed-path regression tests."""

from __future__ import annotations

import importlib

from fastapi.testclient import TestClient
from storage.repositories.route import RoutePlanStore


def _prepare_api(tmp_path, monkeypatch, *, web_api_token: str = ""):
    monkeypatch.chdir(tmp_path)
    fit_dir = tmp_path / "fits"
    fit_dir.mkdir()
    config = {"output_dir": str(fit_dir)}
    if web_api_token:
        config["web_api_token"] = web_api_token
    api = importlib.import_module("app.api")
    monkeypatch.setattr(api, "load_config", lambda: config)
    api.chat_sessions.clear()
    return api, TestClient(api.app), fit_dir


def test_configured_api_token_is_required_for_dashboard(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch, web_api_token="review-token")

    assert client.get("/api/dashboard/status").status_code == 401
    assert client.get("/api/dashboard/status", headers={"X-API-Token": "review-token"}).status_code == 200


def test_analyze_accepts_only_managed_fit_path(tmp_path, monkeypatch):
    api, client, fit_dir = _prepare_api(tmp_path, monkeypatch)
    managed_fit = fit_dir / "managed.fit"
    managed_fit.write_bytes(b"fit")
    outside_fit = tmp_path / "outside.fit"
    outside_fit.write_bytes(b"fit")
    calls = []

    def fake_analyze(path, **kwargs):
        calls.append((path, kwargs))
        return {"status": "ok"}

    monkeypatch.setattr(api, "analyze_fit_document", fake_analyze)

    allowed = client.post("/api/fit-files/analyze", json={"path": str(managed_fit)})
    denied = client.post("/api/fit-files/analyze", json={"path": str(outside_fit)})

    assert allowed.status_code == 200
    assert calls == [(managed_fit, {"use_history": False, "force": False})]
    assert denied.status_code == 403


def test_analyze_history_must_be_explicitly_enabled(tmp_path, monkeypatch):
    api, client, fit_dir = _prepare_api(tmp_path, monkeypatch)
    managed_fit = fit_dir / "managed.fit"
    managed_fit.write_bytes(b"fit")
    calls = []
    monkeypatch.setattr(
        api,
        "analyze_fit_document",
        lambda path, **kwargs: calls.append((path, kwargs)) or {"status": "ok"},
    )

    response = client.post(
        "/api/fit-files/analyze",
        json={"path": str(managed_fit), "history": True},
    )

    assert response.status_code == 200
    assert calls == [(managed_fit, {"use_history": True, "force": False})]


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


def test_strava_upload_uses_activity_key(tmp_path, monkeypatch):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    calls = []

    def fake_upload(activity_key, **kwargs):
        calls.append((activity_key, kwargs))
        return {"status": "uploaded"}

    monkeypatch.setattr(api, "upload_activity_to_strava", fake_upload)

    response = client.post(
        "/api/strava/upload",
        json={"activity_key": "a1", "force": True},
    )

    assert response.status_code == 200
    assert calls == [("a1", {"title": None, "wait": True, "force": True})]


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
        "plan_id": stored["plan_id"],
        "candidate_id": "candidate_2",
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
        "plan_id": stored["plan_id"],
        "operation": "get",
    })
    confirmed = client.post("/api/route-plans/command", json={
        "session_id": "route-command",
        "plan_id": stored["plan_id"],
        "candidate_id": "candidate_1",
        "operation": "confirm",
    })

    assert current.status_code == 200
    assert {item["type"] for item in current.json()["presentations"]} == {"table", "route_map"}
    assert confirmed.status_code == 200
    assert confirmed.json()["result"]["planning"]["status"] == "confirmed"
    assert RoutePlanStore().get(stored["plan_id"])["planning"]["confirmed_candidate_id"] == "candidate_1"


def test_route_command_rejects_unsupported_operation(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch)
    response = client.post("/api/route-plans/command", json={
        "session_id": "route-command",
        "operation": "delete_everything",
    })
    assert response.status_code == 400


def test_garmin_download_delegates_to_activity_operation(tmp_path, monkeypatch):
    api, client, fit_dir = _prepare_api(tmp_path, monkeypatch)
    calls = []

    def fake_sync(*, count, force_download=False):
        calls.append((count, force_download))
        return {
            "fit_dir": str(fit_dir),
            "downloaded": 1,
            "skipped": 1,
            "failed": 0,
            "downloaded_items": [{"activity_id": 1, "paths": ["new.fit"]}],
            "skipped_items": [{"activity_id": 2, "paths": ["old.fit"]}],
            "failed_items": [],
            "index_errors": [],
        }

    monkeypatch.setattr(api, "sync_garmin_activities_tool", fake_sync)

    response = client.post("/api/garmin/download", json={"count": 2, "force_download": True})

    assert response.status_code == 200
    assert calls == [(2, True)]
    assert response.json()["status"] == "ok"
    assert [item["status"] for item in response.json()["results"]] == ["downloaded", "skipped_existing"]


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
    assert set(body) == {"answer", "status", "intent", "skill_id", "executions", "presentations"}
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
