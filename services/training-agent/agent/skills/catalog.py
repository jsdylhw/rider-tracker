"""Static skill catalogue and tool allowlists.

Skill prose never grants authority.  Runtime authorization comes only from
the immutable tool_names below, so prompt changes cannot widen capabilities.
"""

from __future__ import annotations

from agent.skills.models import SkillSpec


# Keep related tools in named capability groups.  Skill allowlists are a
# security boundary, but spelling every list independently made it too easy to
# add a new entry point while accidentally hiding an existing valid tool.
_ACTIVITY_NAVIGATION_TOOLS = (
    "resolve_activities",
    "lookup_activities",
    "navigate_selection",
)

_SELECTION_ANALYSIS_TOOLS = (
    "inspect_selection",
    "analyze_selection",
)

_HISTORY_EVIDENCE_TOOLS = (
    "analyze_training_history",
    "summarize_activities",
    "compare_activities",
    "summarize_recent_training_load",
    "calculate_history_metrics",
)


SKILL_CATALOG: tuple[SkillSpec, ...] = (
    SkillSpec(
        skill_id="manage-activity-library",
        description=(
            "Find and inspect activities already stored in the local library. "
            "Use for locating one or more activities without analysis, Garmin sync, Strava publishing, or training advice."
        ),
        tool_names=_ACTIVITY_NAVIGATION_TOOLS,
        public_intent="analyze_single",
        library_path="activity/manage-activity-library.md",
    ),
    SkillSpec(
        skill_id="analyze-activity",
        description=(
            "Read or generate one activity report and answer focused FIT questions about intervals, sprints, power, heart rate, pace, or running dynamics. "
            "Use only for a single cycling, running, or walking activity."
        ),
        tool_names=(
            *_ACTIVITY_NAVIGATION_TOOLS,
            "find_segments",
            *_SELECTION_ANALYSIS_TOOLS,
            "analyze_activity",
            "query_activity_detail",
        ),
        public_intent="analyze_single",
        library_path="analysis/analyze-activity.md",
    ),
    SkillSpec(
        skill_id="analyze-training-history",
        description=(
            "Summarize, compare, or calculate trends across multiple activities using structured metrics. "
            "Use for recent ranges, weekly or monthly load, progress, consistency, fatigue signals, and matched-session comparisons."
        ),
        tool_names=(
            *_ACTIVITY_NAVIGATION_TOOLS,
            *_SELECTION_ANALYSIS_TOOLS,
            *_HISTORY_EVIDENCE_TOOLS,
        ),
        public_intent="analyze_range",
        library_path="analysis/analyze-training-history.md",
    ),
    SkillSpec(
        skill_id="sync-garmin-activities",
        description=(
            "Download recent Garmin activities into the local library and stop. "
            "Use only for pure sync or download requests that do not also request analysis, reports, summaries, or Strava upload."
        ),
        tool_names=("sync_garmin_activities",),
        public_intent="sync",
        allow_side_effects=True,
        library_path="operations/sync-garmin-activities.md",
    ),
    SkillSpec(
        skill_id="publish-to-strava",
        description=(
            "Publish or refresh local activities on Strava without downloading from Garmin. "
            "Use for upload, re-upload, or description-refresh requests involving activities already in the local library."
        ),
        tool_names=("resolve_activities", "run_activity_workflow"),
        public_intent="upload",
        allow_side_effects=True,
        library_path="operations/publish-to-strava.md",
    ),
    SkillSpec(
        skill_id="run-activity-workflow",
        description=(
            "Start, inspect, retry, or rebuild a recoverable multi-step activity job. "
            "Use for combined goals such as sync then analyze or upload, local batch report generation, workflow status, and workflow recovery."
        ),
        tool_names=(
            "sync_and_run_activity_workflow",
            "run_activity_workflow",
            "rebuild_activity_reports",
            "get_activity_report_job",
            "cancel_activity_report_job",
            "get_activity_workflow",
            "retry_activity_workflow",
        ),
        public_intent="mixed",
        allow_side_effects=True,
        library_path="operations/run-activity-workflow.md",
    ),
    SkillSpec(
        skill_id="coach-training",
        description=(
            "Give evidence-based training or recovery guidance from selected activities and structured training metrics. "
            "Use for next-session suggestions, weekly plans, recovery choices, and training-load interpretation."
        ),
        tool_names=(
            *_ACTIVITY_NAVIGATION_TOOLS,
            *_SELECTION_ANALYSIS_TOOLS,
            *_HISTORY_EVIDENCE_TOOLS,
            "generate_training_advice",
        ),
        public_intent="training_advice",
        library_path="coaching/coach-training.md",
    ),
    SkillSpec(
        skill_id="plan-routes",
        description=(
            "Create, discover, persist, inspect, or conversationally edit a real cycling route. Use for explicit "
            "waypoints, open-ended route ideas, complete popular loops, multi-day trips, and day-part plans."
        ),
        tool_names=(
            "create_route_plan", "create_itinerary_plan",
            "update_route_plan", "get_route_plan", "explore_route_segments",
        ),
        public_intent="route_advice",
        library_path="route/plan-routes.md",
    ),
)

_BY_ID = {skill.skill_id: skill for skill in SKILL_CATALOG}
_LEGACY_ALIASES = {
    "discover-routes": "plan-routes",
    "plan-waypoint-route": "plan-routes",
    "plan-popular-loop": "plan-routes",
}


def get_skill(skill_id: str | None) -> SkillSpec | None:
    """Return a registered skill without accepting prompt-defined skills."""
    normalized = str(skill_id or "")
    return _BY_ID.get(_LEGACY_ALIASES.get(normalized, normalized))


def list_skill_descriptors() -> list[dict[str, str]]:
    """Return only stage-one metadata, never instructions or tool schemas."""
    return [skill.public_descriptor() for skill in SKILL_CATALOG]


def skill_allows_tool(skill: SkillSpec | None, tool_name: str) -> bool:
    """Check the immutable Skill allowlist independently of model output."""
    return skill is not None and tool_name in skill.tool_names
