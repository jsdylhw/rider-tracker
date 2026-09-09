"""Read-only range summary regressions."""

from agent.main_agent.context import AgentContext
from agent.tools.handlers.activity_summary import execute_summarize_activity_range


def test_range_summary_reports_coverage_without_generating_missing_reports():
    context = AgentContext(
        session_id="range-read-only",
        selected_activities=[
            {
                "activity_key": "with-report",
                "start_time_local": "2026-08-01T08:00:00",
                "distance_km": 10.0,
                "duration_min": 30.0,
                "has_summary": True,
            },
            {
                "activity_key": "facts-only",
                "start_time_local": "2026-08-02T08:00:00",
                "distance_km": 12.0,
                "duration_min": 40.0,
                "has_summary": False,
            },
        ],
        selected_activity_range={"kind": "recent", "limit": 2},
    )

    output = execute_summarize_activity_range(
        "summarize_activities", {"response_mode": "compact"}, context,
    )

    assert output["status"] == "completed"
    assert output["result"]["report_coverage"] == {
        "available_count": 1,
        "missing_count": 1,
    }
    assert "summary_generation" not in output["result"]
