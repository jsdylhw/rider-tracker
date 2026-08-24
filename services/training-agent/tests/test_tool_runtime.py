from __future__ import annotations

from agent.main_agent.context import AgentContext
from agent.main_agent.guard import guard_tool_call
from agent.tools.registry import TOOL_HANDLERS
from agent.tools.agent_tools import MAIN_AGENT_TOOLS


def test_every_declared_tool_has_exactly_one_callable_handler():
    declared = {tool.name for tool in MAIN_AGENT_TOOLS}

    assert set(TOOL_HANDLERS) == declared
    assert all(callable(handler) for handler in TOOL_HANDLERS.values())


def test_tool_handler_executes_selection_directly(monkeypatch):
    from agent.tools.handlers.activity_selection import resolve_activities

    called = {}

    def fake_selection(args, context):
        called["arguments"] = args
        return {"step": "resolve_activities", "status": "completed"}

    assert TOOL_HANDLERS["resolve_activities"] is resolve_activities
    monkeypatch.setitem(TOOL_HANDLERS, "resolve_activities", fake_selection)

    result = TOOL_HANDLERS["resolve_activities"](
        {"kind": "recent", "limit": 1},
        AgentContext(session_id="direct-tool"),
    )

    assert result == {"step": "resolve_activities", "status": "completed"}
    assert called == {"arguments": {"kind": "recent", "limit": 1}}


def test_workflow_handler_returns_service_result_directly(monkeypatch):
    context = AgentContext(session_id="workflow-tool")
    monkeypatch.setattr(
        "operations.activity.workflow_service.start_local_activity_workflow",
        lambda **kwargs: {
            "status": "completed",
            "workflow_id": "run-1",
            "execution": {"waiting_for": []},
        },
    )

    result = TOOL_HANDLERS["run_activity_workflow"](
        {"limit": 5, "goals": ["upload_strava"]},
        context,
    )

    assert result["status"] == "completed"
    assert result["workflow_id"] == "run-1"


def test_sync_workflow_handler_returns_service_result_directly(monkeypatch):
    context = AgentContext(session_id="sync-workflow-tool")
    context.set_single_activity(__import__("domain.activity.models", fromlist=["ActivityHandle"]).ActivityHandle(
        activity_key="old", fit_path="old.fit",
    ))
    monkeypatch.setattr(
        "operations.activity.workflow_service.sync_and_start_activity_workflow",
        lambda **kwargs: {
            "status": "completed", "workflow_id": "run-2",
            "execution": {"waiting_for": []},
            "activities": [{"activity_key": "new", "fit_path": "new.fit"}],
        },
    )
    monkeypatch.setattr(
        "agent.tools.handlers.activity_operations.ActivityStore.get_activity",
        lambda self, key: {
            "activity_key": key, "fit_path": "new.fit", "sport_type": "cycling",
            "start_time_local": "2026-08-20T11:00:00",
        },
    )

    result = TOOL_HANDLERS["sync_and_run_activity_workflow"](
        {"count": 5, "goals": ["upload_strava"]}, context,
    )

    assert result["status"] == "completed"
    assert result["workflow_id"] == "run-2"
    assert context.current_activity_key == "new"
    assert str(context.current_fit_file) == "new.fit"
    assert context.selected_activity_range == {
        "type": "garmin_sync_result", "workflow_id": "run-2",
    }


def test_pure_sync_handler_does_not_start_activity_workflow(monkeypatch):
    context = AgentContext(session_id="pure-sync-tool")
    calls = []
    monkeypatch.setattr(
        "operations.activity.sync.sync_recent",
        lambda **kwargs: calls.append(kwargs) or {
            "status": "completed", "downloaded": 2, "skipped": 1, "failed": 0,
        },
    )

    result = TOOL_HANDLERS["sync_garmin_activities"]({"count": 3}, context)

    assert calls == [{"count": 3, "force_download": False}]
    assert result == {"status": "completed", "downloaded": 2, "skipped": 1, "failed": 0}
    assert "workflow_id" not in result


def test_guard_rejects_registered_tool_outside_the_current_category_allowlist():
    result = guard_tool_call(
        "sync_and_run_activity_workflow",
        {"count": 1},
        context=AgentContext(session_id="guard"),
        allowed_categories={"conversation"},
    )

    assert result.allowed is False
    assert "不在本轮允许" in result.reason


def test_guard_rejects_unknown_tool_before_handler_dispatch():
    result = guard_tool_call(
        "unadvertised_side_effect",
        {},
        context=AgentContext(session_id="guard"),
        allowed_categories={"conversation"},
    )

    assert result.allowed is False
    assert "未知或未注册" in result.reason


def test_analyze_activity_refuses_to_reanalyze_a_selected_range():
    context = AgentContext(session_id="range", selected_activities=[{"activity_key": "a1"}, {"activity_key": "a2"}])

    result = TOOL_HANDLERS["analyze_activity"]({}, context)

    assert result["error"] == "single_activity_required"


def test_main_agent_exposes_explicit_detail_query_instead_of_implicit_targeted_analysis():
    names = {tool.name for tool in MAIN_AGENT_TOOLS}

    assert "query_activity_detail" in names
    assert "calculate_history_metrics" in names
    assert "analyze_training_history" in names
    resolver_schema = next(tool for tool in MAIN_AGENT_TOOLS if tool.name == "resolve_activities").input_schema
    assert resolver_schema["properties"]["days"]["minimum"] == 1
    assert "longest" in resolver_schema["properties"]["order"]["enum"]
    assert resolver_schema["required"] == ["kind"]
    assert "user_request" not in next(tool for tool in MAIN_AGENT_TOOLS if tool.name == "analyze_activity").input_schema["properties"]


def test_garmin_sync_tools_require_structured_activity_count_and_workflow_goals():
    schemas = {tool.name: tool.input_schema for tool in MAIN_AGENT_TOOLS}

    assert schemas["sync_garmin_activities"]["required"] == ["count"]
    assert "default" not in schemas["sync_garmin_activities"]["properties"]["count"]
    assert schemas["sync_and_run_activity_workflow"]["required"] == ["count", "goals"]
    assert "default" not in schemas["sync_and_run_activity_workflow"]["properties"]["count"]


def test_history_metrics_handler_uses_selected_activities(monkeypatch):
    captured = {}

    def fake_tool(context, *, group_by, name):
        captured.update({"context": context, "group_by": group_by, "name": name})
        return {"status": "completed"}

    monkeypatch.setattr("agent.tools.handlers.activity_insights.calculate_history_metrics_tool", fake_tool)
    context = AgentContext(session_id="history", selected_activities=[{"activity_key": "a1"}])

    result = TOOL_HANDLERS["calculate_history_metrics"]({"group_by": "month"}, context)

    assert result == {"status": "completed"}
    assert captured == {"context": context, "group_by": "month", "name": "calculate_history_metrics"}


def test_professional_history_handler_forwards_bounded_options(monkeypatch):
    captured = {}

    def fake_tool(context, **kwargs):
        captured.update({"context": context, **kwargs})
        return {"status": "completed"}

    monkeypatch.setattr("agent.tools.handlers.activity_insights.analyze_training_history_tool", fake_tool)
    context = AgentContext(session_id="history-analysis", selected_activities=[{"activity_key": "a1"}])

    result = TOOL_HANDLERS["analyze_training_history"]({
        "group_by": "month", "sport_type": "cycling", "combine_sports_for_volume": False,
    }, context)

    assert result == {"status": "completed"}
    assert captured == {
        "context": context, "group_by": "month", "sport_type": "cycling",
        "combine_sports_for_volume": False, "name": "analyze_training_history",
    }


def test_guard_requires_activity_selection_for_history_metrics():
    result = guard_tool_call(
        "calculate_history_metrics",
        {"group_by": "week"},
        context=AgentContext(session_id="guard-history"),
        allowed_categories={"analysis"},
        has_resolved=False,
    )

    assert result.allowed is False
    assert "需要先定位活动" in result.reason


def test_resolve_activities_rejects_mixed_kinds_instead_of_guessing():
    result = TOOL_HANDLERS["resolve_activities"](
        {"kind": "recent", "date": "today", "limit": 1},
        AgentContext(session_id="ambiguous-selection"),
    )

    assert result["error"] == "invalid_activity_selection"
