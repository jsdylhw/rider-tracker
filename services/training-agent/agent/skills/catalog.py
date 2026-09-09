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
            "查找和查看本地活动库中已有的活动。用于定位一条或多条活动，"
            "不执行分析、Garmin 同步、Strava 发布或训练建议。"
        ),
        tool_names=_ACTIVITY_NAVIGATION_TOOLS,
        public_intent="analyze_single",
        library_path="activity/manage-activity-library.md",
    ),
    SkillSpec(
        skill_id="analyze-activity",
        description=(
            "读取或生成单次活动报告，并回答关于间歇、冲刺、功率、心率、配速或跑步动态的 FIT 精确问题。"
            "仅用于一条骑行、跑步或步行活动。"
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
            "使用结构化指标总结、比较或计算多条活动的趋势。用于近期范围、周/月负荷、进步、"
            "训练一致性、疲劳信号和可比训练比较。"
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
            "把近期 Garmin 活动下载到本地活动库后结束。仅用于纯同步或下载请求；"
            "如果同时要求分析、报告、总结或上传 Strava，则不要使用。"
        ),
        tool_names=("sync_garmin_activities",),
        public_intent="sync",
        allow_side_effects=True,
        library_path="operations/sync-garmin-activities.md",
    ),
    SkillSpec(
        skill_id="publish-to-strava",
        description=(
            "将本地活动发布或刷新到 Strava，不从 Garmin 下载。用于上传、重新上传或刷新描述等"
            "针对本地已有活动的请求。"
        ),
        tool_names=("resolve_activities", "run_activity_workflow"),
        public_intent="upload",
        allow_side_effects=True,
        library_path="operations/publish-to-strava.md",
    ),
    SkillSpec(
        skill_id="run-activity-workflow",
        description=(
            "启动、查看、重试或重建可恢复的多步骤活动任务。用于同步后分析或上传、本地批量报告生成、"
            "工作流状态查询和工作流恢复等组合目标。"
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
            "根据选中活动和结构化训练指标提供有证据支持的训练或恢复建议。用于下一次训练建议、"
            "周计划、恢复选择和训练负荷解释。"
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
            "创建、发现、保存、查看或通过对话修改真实骑行路线。用于明确途经点、开放式路线需求、"
            "完整热门环线、多日行程和单日分段计划。"
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
