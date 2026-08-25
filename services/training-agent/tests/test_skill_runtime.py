from __future__ import annotations

from agent.main_agent.context import AgentContext
from agent.main_agent.guard import guard_tool_call
from agent.main_agent.turn_control import handle_control_turn
from agent.main_agent.turn_policy import requires_raw_window_evidence, tools_for_skill
from agent.tools.handlers.control import activate_skill
from agent.skills.catalog import get_skill, list_skill_descriptors
from agent.skills.loader import load_skill_instructions, load_sport_references
from agent.tools.agent_tools import MAIN_AGENT_TOOLS


def test_skill_tool_guard_rejects_registered_tool_outside_active_skill():
    analysis = get_skill("analyze-activity")
    result = guard_tool_call(
        "sync_garmin_activities",
        {"count": 3},
        context=AgentContext(session_id="skill-guard"),
        allowed_categories={"analysis", "activity_selection", "operation"},
        allowed_tool_names=set(analysis.tool_names),
    )

    assert result.allowed is False
    assert "当前激活 Skill" in result.reason


def test_skill_body_loads_only_after_selection_and_sport_reference_is_structured():
    skill = get_skill("analyze-activity")

    body = load_skill_instructions(skill)
    references = load_sport_references(skill, sport_types=["running"])

    assert "# Analyze Activity" in body
    assert "# Cycling evidence" not in body
    assert len(references) == 1
    assert references[0].startswith("# Running evidence")


def test_history_skill_loads_professional_methodology_and_output_contract():
    body = load_skill_instructions(get_skill("analyze-training-history"))

    assert "# Analyze Training History" in body
    assert "# Endurance history methodology" in body
    assert "# Training history output contract" in body
    assert "two aligned evidence lanes" in body


def test_no_conversation_skill_is_registered():
    assert get_skill("conversation") is None


def test_skill_activation_records_last_and_conversation_skill_history():
    context = AgentContext(session_id="recent-skill")

    output = activate_skill({"skill_id": "plan-routes"}, context)

    assert output["status"] == "activated"
    assert context.active_skill_id == "plan-routes"
    assert context.last_used_skills == ["plan-routes"]
    assert context.conversation_used_skills == ["plan-routes"]

    activate_skill({"skill_id": "analyze-activity"}, context)
    assert context.last_used_skills == ["analyze-activity"]
    assert context.conversation_used_skills == ["plan-routes", "analyze-activity"]


def test_legacy_route_skill_restores_as_route_discovery():
    assert get_skill("plan-routes").skill_id == "plan-routes"


def test_route_discovery_creates_real_candidates_without_generic_advice_tool():
    tools = set(get_skill("discover-routes").tool_names)

    assert "generate_route_advice" not in tools
    assert {"create_route_plan", "create_itinerary_plan"} <= tools
    assert "create_popular_loop" not in tools


def test_route_tools_derive_closure_from_waypoint_order():
    create_route = next(tool for tool in MAIN_AGENT_TOOLS if tool.name == "create_route_plan")
    update_route = next(tool for tool in MAIN_AGENT_TOOLS if tool.name == "update_route_plan")
    candidate = create_route.input_schema["properties"]["candidates"]["items"]

    assert "route_type" not in candidate["required"]
    assert "route_type" not in candidate["properties"]
    assert "route_type" not in update_route.input_schema["properties"]


def test_analysis_skills_keep_established_and_unified_tool_entry_points():
    """Adding selection APIs must not silently hide established analysis tools."""
    single = set(get_skill("analyze-activity").tool_names)
    history = set(get_skill("analyze-training-history").tool_names)
    coaching = set(get_skill("coach-training").tool_names)

    assert {
        "resolve_activities", "lookup_activities", "find_segments", "navigate_selection",
        "inspect_selection", "analyze_selection", "analyze_activity",
        "query_activity_detail",
    } <= single
    assert {
        "resolve_activities", "lookup_activities", "navigate_selection", "inspect_selection",
        "analyze_selection", "summarize_activities", "compare_activities",
        "summarize_recent_training_load", "calculate_history_metrics",
        "analyze_training_history",
    } <= history
    assert {
        "resolve_activities", "lookup_activities", "navigate_selection", "inspect_selection",
        "analyze_selection", "summarize_activities", "compare_activities",
        "summarize_recent_training_load", "calculate_history_metrics",
        "generate_training_advice",
    } <= coaching


def test_explicit_window_hides_candidate_tools_but_keeps_targeted_query():
    skill = get_skill("analyze-activity")
    tools = tools_for_skill(skill, "这次 100–200 秒有没有连续冲刺？")

    assert "query_activity_detail" in tools
    assert "resolve_activities" in tools
    assert "find_segments" not in tools
    assert "analyze_selection" not in tools
    assert requires_raw_window_evidence("第 3–5 km 的爬坡怎么样？")
    assert not requires_raw_window_evidence("看看这次有没有冲刺")


def test_every_skill_allowlist_name_has_a_registered_main_agent_tool():
    """A stale allowlist entry would otherwise be loaded but never callable."""
    registered = {tool.name for tool in MAIN_AGENT_TOOLS}

    for descriptor in list_skill_descriptors():
        skill = get_skill(descriptor["skill_id"])
        assert set(skill.tool_names) <= registered


def test_every_business_tool_is_reachable_from_at_least_one_skill():
    """Conversation fallbacks are the only tools intentionally outside Skills."""
    registered = {tool.name for tool in MAIN_AGENT_TOOLS}
    reachable = {
        tool_name
        for descriptor in list_skill_descriptors()
        for tool_name in get_skill(descriptor["skill_id"]).tool_names
    }

    assert registered - reachable == {"activate_skill", "casual_chat", "ask_user_clarification"}


def test_direct_retry_rejects_action_outside_previous_active_skill():
    context = AgentContext(
        session_id="retry-skill-guard",
        active_skill_id="analyze-activity",
        last_failed_action={"tool": "sync_garmin_activities", "input": {"count": 3}},
    )

    result = handle_control_turn("重试", context)

    assert result["status"] == "retry_rejected"
    assert context.last_failed_action is None


def test_short_ordinal_and_back_commands_mutate_persisted_navigation(tmp_path):
    from agent.analysis.workspace import AnalysisNavigationService
    from services.activity.catalog import replace_activity_entries

    database = tmp_path / "activities.db"
    replace_activity_entries([
        {
            "activity_key": key, "fit_path": f"/tmp/{key}.fit", "file_name": f"{key}.fit",
            "start_time_local": f"2026-05-0{index}T08:00:00", "date_local": f"2026-05-0{index}",
        }
        for index, key in enumerate(("a1", "a2", "a3"), 1)
    ], path=database)
    context = AgentContext(session_id="navigation", workspace_id="navigation")
    context.set_selected_activities([])
    service = AnalysisNavigationService(database)
    activities = [service.activities.get_activity(key) for key in ("a3", "a2", "a1")]
    service.replace_activities(context, activities, scope={"kind": "recent", "limit": 3})

    with __import__("unittest.mock", fromlist=["patch"]).patch(
        "agent.tools.handlers.activity_analysis.AnalysisNavigationService",
        return_value=service,
    ):
        selected = handle_control_turn("看第二个", context)
        assert selected["status"] == "completed"
        assert context.current_activity_key == "a2"
        assert service.current_focus(context) == {"type": "activity", "id": "a2"}

        backed = handle_control_turn("返回", context)
        assert backed["status"] == "completed"
        assert [item["activity_key"] for item in context.selected_activities] == ["a3", "a2", "a1"]
        assert service.current_focus(context)["type"] == "activity_set"

        qualified = handle_control_turn("看第二个，只查看轻量概览，不生成报告。", context)
        assert qualified["status"] == "completed"
        assert context.current_activity_key == "a2"
        assert service.current_focus(context) == {"type": "activity", "id": "a2"}


def test_long_ordinal_analysis_request_is_not_consumed_as_navigation():
    context = AgentContext(
        session_id="navigation-objective",
        analysis_navigation={"focus_stack": [{"type": "activity_set", "ids": ["a1", "a2"]}]},
    )

    assert handle_control_turn("分析第二个活动的心率", context) is None
