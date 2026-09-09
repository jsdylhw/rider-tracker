from __future__ import annotations

from domain.activity.models import ActivityHandle
from agent.analysis.workspace import AnalysisNavigationService
from agent.main_agent.context import AgentContext
from storage.repositories.activity import ActivityStore
from storage.repositories.analysis import AnalysisStore


def _activity(activity_id: str, fit_path: str, started_at: str) -> dict:
    return {
        "activity_key": activity_id,
        "fit_path": fit_path,
        "file_name": fit_path.rsplit("/", 1)[-1],
        "sport_type": "cycling",
        "start_time_local": started_at,
        "date_local": started_at[:10],
        "duration_min": 20,
        "distance_km": 8,
    }


def test_navigation_freezes_collection_order_and_restores_current_activity(tmp_path):
    database = tmp_path / "activities.db"
    first = _activity("a1", str(tmp_path / "a1.fit"), "2026-08-10T08:00:00")
    second = _activity("a2", str(tmp_path / "a2.fit"), "2026-08-11T08:00:00")
    store = ActivityStore(database)
    store.upsert_activity(first)
    store.upsert_activity(second)
    context = AgentContext(session_id="one", workspace_id="commute")
    context.set_selected_activities(
        [ActivityHandle.from_index_entry(second), ActivityHandle.from_index_entry(first)],
        scope={"type": "recent_activities", "limit": 2},
    )
    navigation = AnalysisNavigationService(database)

    navigation.replace_activities(context, context.selected_activities, scope=context.selected_activity_range)
    navigation.navigate(context, action="select", ordinal=2)

    restored = AgentContext(session_id="two", workspace_id="commute")
    navigation.load_into_context(restored)
    assert restored.current_activity_key == "a1"
    assert [item["activity_key"] for item in restored.selected_activities] == ["a1"]
    assert restored.analysis_navigation["root_scope"]["ids"] == ["a2", "a1"]


def test_navigation_uses_nearest_collection_for_segment_ordinal(tmp_path):
    database = tmp_path / "activities.db"
    activity = _activity("a1", str(tmp_path / "a1.fit"), "2026-08-10T08:00:00")
    ActivityStore(database).upsert_activity(activity)
    context = AgentContext(session_id="one", workspace_id="segments")
    context.set_single_activity(ActivityHandle.from_index_entry(activity))
    navigation = AnalysisNavigationService(database)
    navigation.replace_activities(context, context.selected_activities, scope=context.selected_activity_range)
    navigation.push_segments(context, [
        {"segment_id": "s1", "activity_id": "a1", "segment_type": "sprint", "ordinal": 1},
        {"segment_id": "s2", "activity_id": "a1", "segment_type": "sprint", "ordinal": 2},
    ])

    navigation.navigate(context, action="select", ordinal=2)

    assert navigation.current_focus(context)["id"] == "s2"
    assert navigation.nearest_activity_ids(context) == ["a1"]


def test_analysis_store_keeps_focused_result_separate_from_activity_report(tmp_path):
    database = tmp_path / "activities.db"
    result = AnalysisStore(database).save_result(
        workspace_id="default",
        request={"objective": "analyze_hr_drift"},
        target={"activity_ids": ["a1"]},
        result={"facts": {"drift_percent": 4.2}},
    )

    stored = AnalysisStore(database).get_result(result["id"])
    assert stored["result"]["facts"]["drift_percent"] == 4.2
    assert ActivityStore(database).report_counts() == {}
