from __future__ import annotations

from datetime import date

import pytest

from agent.main_agent.context import AgentContext
from domain.activity.models import ActivityHandle
from agent.tools.handlers.activity_selection import lookup_activities, resolve_activities
from domain.activity.selection import ActivitySelectionRequest
from services.activity.catalog import replace_activity_entries


def _write_catalog(path):
    replace_activity_entries(
        [
            {
                "activity_key": "a1", "file_name": "morning.fit", "fit_path": "/tmp/morning.fit",
                "sport_type": "cycling", "start_time_local": "2026-05-18T08:00:00",
                "date_local": "2026-05-18", "duration_s": 1800, "distance_m": 12000,
            },
            {
                "activity_key": "a2", "file_name": "evening.fit", "fit_path": "/tmp/evening.fit",
                "sport_type": "cycling", "start_time_local": "2026-05-18T20:00:00",
                "date_local": "2026-05-18", "duration_s": 2400, "distance_m": 18000,
            },
            {
                "activity_key": "a3", "file_name": "today.fit", "fit_path": "/tmp/today.fit",
                "sport_type": "running", "start_time_local": "2026-05-19T07:00:00",
                "date_local": "2026-05-19", "duration_s": 1200, "distance_m": 3000,
            },
        ],
        path=path,
    )


def _resolve(path, arguments, *, today=date(2026, 5, 19), context=None):
    context = context or AgentContext(session_id="test", workspace_id="test")
    return resolve_activities(arguments, context, path=path, today=today), context


def test_recent_selection_has_explicit_kind_and_exact_limit(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)

    result, context = _resolve(database, {"kind": "recent", "limit": 2})

    assert result["result"]["count"] == 2
    assert [item["activity_key"] for item in result["result"]["activities"]] == ["a3", "a2"]
    assert context.selected_activity_range == {"kind": "recent", "order": "latest", "limit": 2}


def test_recent_default_limit_matches_tool_contract(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)

    result, context = _resolve(database, {"kind": "recent"})

    assert result["result"]["request"]["limit"] == 1
    assert [item["activity_key"] for item in context.selected_activities] == ["a3"]


def test_recent_filters_before_limit(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)

    result, _ = _resolve(database, {"kind": "recent", "limit": 2, "time_of_day": "morning"})

    assert [item["activity_key"] for item in result["result"]["activities"]] == ["a3", "a1"]


def test_date_selection_returns_all_matches_unless_limited(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)

    all_result, _ = _resolve(database, {"kind": "date", "date": "yesterday"})
    one_result, context = _resolve(
        database,
        {"kind": "date", "date": "yesterday", "limit": 1, "order": "latest"},
    )

    assert [item["activity_key"] for item in all_result["result"]["activities"]] == ["a2", "a1"]
    assert [item["activity_key"] for item in one_result["result"]["activities"]] == ["a2"]
    assert context.current_activity_key == "a2"


def test_range_limit_is_applied_after_date_filtering(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)

    result, context = _resolve(database, {
        "kind": "range", "start_date": "2026-05-18", "end_date": "2026-05-19",
        "limit": 2, "order": "latest",
    })

    assert result["result"]["count"] == 2
    assert [item["activity_key"] for item in context.selected_activities] == ["a3", "a2"]


@pytest.mark.parametrize(
    ("relative_range", "current", "start", "end"),
    [
        ("this_week", date(2026, 5, 21), "2026-05-18", "2026-05-21"),
        ("last_week", date(2026, 5, 21), "2026-05-11", "2026-05-17"),
        ("this_month", date(2026, 5, 21), "2026-05-01", "2026-05-21"),
        ("last_month", date(2026, 5, 21), "2026-04-01", "2026-04-30"),
    ],
)
def test_relative_ranges_are_resolved_deterministically(tmp_path, relative_range, current, start, end):
    database = tmp_path / "activities.db"
    _write_catalog(database)

    result, _ = _resolve(database, {"kind": "range", "relative_range": relative_range}, today=current)

    assert result["result"]["request"]["start_date"] == start
    assert result["result"]["request"]["end_date"] == end


def test_key_index_name_and_all_use_uniform_list_result(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)

    cases = [
        ({"kind": "key", "activity_key": "a2"}, ["a2"]),
        ({"kind": "index", "activity_index": 2}, ["a2"]),
        ({"kind": "name", "name": "morning"}, ["a1"]),
        ({"kind": "all", "order": "earliest"}, ["a1", "a2", "a3"]),
    ]
    for arguments, expected in cases:
        result, _ = _resolve(database, arguments)
        assert result["result"]["schema_version"] == "activity_selection.v2"
        assert [item["activity_key"] for item in result["result"]["activities"]] == expected


def test_longest_order_resolves_one_activity_deterministically(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)

    result, context = _resolve(database, {"kind": "all", "order": "longest", "limit": 1})

    assert result["result"]["request"] == {"kind": "all", "order": "longest", "limit": 1}
    assert [item["activity_key"] for item in result["result"]["activities"]] == ["a2"]
    assert context.current_activity_key == "a2"


def test_current_reuses_frozen_selection_order(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)
    context = AgentContext(session_id="test", workspace_id="test")
    _resolve(database, {"kind": "recent", "limit": 2}, context=context)

    result, context = _resolve(database, {"kind": "current"}, context=context)

    assert [item["activity_key"] for item in result["result"]["activities"]] == ["a3", "a2"]
    assert [item["activity_key"] for item in context.selected_activities] == ["a3", "a2"]


def test_current_does_not_replace_navigation_root_after_ordinal_selection(tmp_path):
    from agent.analysis.workspace import AnalysisNavigationService

    database = tmp_path / "activities.db"
    _write_catalog(database)
    context = AgentContext(session_id="test", workspace_id="test")
    _resolve(database, {"kind": "recent", "limit": 2}, context=context)
    navigation = AnalysisNavigationService(database)
    navigation.navigate(context, action="select", ordinal=2)

    _resolve(database, {"kind": "current"}, context=context)

    assert context.analysis_navigation["root_scope"]["ids"] == ["a3", "a2"]
    assert context.analysis_navigation["focus_stack"][-1] == {"type": "activity", "id": "a2"}


def test_auxiliary_lookup_does_not_replace_frozen_navigation_or_current_focus(tmp_path):
    """An independent catalogue lookup must not break an ordinal follow-up."""
    database = tmp_path / "activities.db"
    _write_catalog(database)
    context = AgentContext(session_id="test", workspace_id="test")
    _resolve(database, {"kind": "recent", "limit": 2}, context=context)

    from agent.analysis.workspace import AnalysisNavigationService

    AnalysisNavigationService(database).navigate(context, action="select", ordinal=2)
    before_range = dict(context.selected_activity_range or {})
    before_navigation = dict(context.analysis_navigation or {})

    result = lookup_activities(
        {"kind": "all", "limit": 1, "order": "earliest"},
        context,
        path=database,
        today=date(2026, 5, 19),
    )

    assert [item["activity_key"] for item in result["result"]["activities"]] == ["a1"]
    assert result["navigation_changed"] is False
    assert context.selected_activity_range == before_range
    assert context.analysis_navigation == before_navigation
    assert context.current_activity_key == "a2"


def test_empty_selection_clears_context_and_persisted_navigation(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)
    context = AgentContext(session_id="test", workspace_id="test")
    _resolve(database, {"kind": "recent", "limit": 2}, context=context)

    result, context = _resolve(database, {"kind": "key", "activity_key": "missing"}, context=context)

    assert result["result"]["count"] == 0
    assert context.selected_activities == []
    assert context.analysis_navigation["focus_stack"] == [{"type": "activity_set", "ids": []}]


@pytest.mark.parametrize(
    "arguments",
    [
        {"limit": 3},
        {"kind": "recent", "start_date": "2026-05-01", "limit": 3},
        {"kind": "date", "date": "today", "activity_key": "a1"},
        {"kind": "range", "days": 30, "relative_range": "this_month"},
        {"kind": "key"},
        {"kind": "recent", "limit": "three"},
    ],
)
def test_invalid_or_ambiguous_requests_fail_closed(arguments):
    with pytest.raises(ValueError):
        ActivitySelectionRequest.from_arguments(arguments)


def test_invalid_request_does_not_replace_existing_context(tmp_path):
    database = tmp_path / "activities.db"
    _write_catalog(database)
    context = AgentContext(session_id="test", workspace_id="test")
    _resolve(database, {"kind": "recent", "limit": 2}, context=context)

    result, context = _resolve(
        database,
        {"kind": "recent", "start_date": "2026-05-01", "limit": 1},
        context=context,
    )

    assert result["error"] == "invalid_activity_selection"
    assert [item["activity_key"] for item in context.selected_activities] == ["a3", "a2"]

def test_selecting_activity_without_fit_path_clears_previous_fit_shortcut():
    context = AgentContext(session_id="stale-fit")
    context.set_single_activity(ActivityHandle(activity_key="old", fit_path="/tmp/old.fit"))

    context.set_single_activity(ActivityHandle(activity_key="new", fit_path=None))

    assert context.current_activity_key == "new"
    assert context.current_fit_file is None
