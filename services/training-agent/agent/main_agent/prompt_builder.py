"""Build bounded prompts from Skill metadata and persisted turn state."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from agent.main_agent.context import AgentContext
from agent.skills import list_skill_descriptors


def build_system_prompt(
    *,
    allow_side_effects: bool = False,
    skill_instructions: str = "",
    skill_catalog: str = "",
) -> str:
    """Build the stable system contract for one main-agent turn."""
    side = "当前已激活 Skill 允许使用其明确暴露的副作用工具。" if allow_side_effects else ""
    local_today = datetime.now().astimezone().date().isoformat()
    skill_section = (
        f"\n当前已激活 Skill 的领域协议如下。只按该协议和已暴露工具完成任务：\n\n{skill_instructions}\n"
        if skill_instructions else "\n本轮尚未激活领域 Skill，只有 Skill 激活工具可用。普通聊天直接回答。\n"
    )
    if skill_catalog and not skill_instructions:
        skill_section = (
            "\n本轮尚未激活领域 Skill。普通聊天直接回答；领域请求必须先调用 "
            "activate_skill，且每轮最多激活一个。可用 Skill：\n"
            f"{skill_catalog}\n"
        )
    return f"""你是 Personal FIT Agent。领域能力采用渐进式 Skill 激活协议。
{side}
{skill_section}
规则:
- 普通聊天直接回答，不调用 activate_skill。活动领域请求先选择最匹配的一个 Skill，并调用 activate_skill；每个用户回合最多激活一个 Skill。
- activate_skill 返回的 instructions 是本回合后续行为的领域协议，allowed_tools 是精确工具白名单；必须等到下一次模型调用才能使用这些业务工具。
- 只能调用当前实际暴露的工具；不得猜测、拼接或请求其他 Skill 的工具。同步、上传等副作用也只能通过已激活 Skill 明确暴露的工具执行。
- 当前本地日期是 {local_today}。用户说“今天/昨天”时必须传 date=today/date=yesterday，让本地工具解析；不要猜测或自行改写为其他 ISO 日期。
- 活动筛选只传日期、范围、数量、时间段、运动类型等事实条件，不自行编造数据库字段或活动标识。
- 完成后用简洁中文回答：若调用了工具，先以“已处理：活动/范围｜操作”说明处理对象和操作；再给 1-2 句结论，以及最多 3 条证据或建议。除非用户要求比较，不要堆叠大表格、重复基础指标、表情或客套开场。
- 不要编造数据
"""


def build_skill_catalog_prompt() -> str:
    """Render stage-one metadata without Skill bodies or business tools."""
    return "\n".join(
        f"- {item['skill_id']}: {item['description']}"
        for item in list_skill_descriptors()
    )


def build_state_preamble(context: AgentContext) -> str:
    """Expose compact persisted state without replaying prior tool payloads."""
    parts: list[str] = []
    if context.current_fit_file:
        parts.append(f"当前 FIT: {context.current_fit_file}")
    if context.selected_activities:
        parts.append(f"已选活动: {len(context.selected_activities)} 条")
    if context.selected_activity_range:
        parts.append(f"活动范围: {json.dumps(context.selected_activity_range, ensure_ascii=False)}")
    navigation = context.analysis_navigation if isinstance(context.analysis_navigation, dict) else None
    if navigation:
        stack = navigation.get("focus_stack") if isinstance(navigation.get("focus_stack"), list) else []
        current = stack[-1] if stack else None
        if current:
            parts.append(f"分析导航焦点: {json.dumps(current, ensure_ascii=False, default=str)}")
        if navigation.get("last_result_id"):
            parts.append(f"最近分析结果: {navigation['last_result_id']}（已持久化，可用于恢复回答）")
    if context.workspace_id:
        from storage.repositories.route import RoutePlanStore

        route_plan = RoutePlanStore().get_latest(context.workspace_id)
        if route_plan:
            candidates = [item for item in route_plan.get("candidates") or [] if isinstance(item, dict)]
            active_id = route_plan.get("active_candidate_id")
            active = next((item for item in candidates if item.get("candidate_id") == active_id), None)
            stages = [
                stage for stage in (active.get("stages") or [] if isinstance(active, dict) else [])
                if isinstance(stage, dict)
            ]
            if stages:
                route_state = "；".join(_compact_route_stage_state(stage) for stage in stages)
                segment_count = sum(
                    len(stage.get("strava_segments") or []) for stage in stages
                )
            else:
                waypoint_names = [
                    str(point.get("name") or point.get("query") or "")
                    for point in (active.get("waypoints") or [] if isinstance(active, dict) else [])
                    if isinstance(point, dict)
                ]
                route_state = f"途经 {' → '.join(waypoint_names) or '-'}"
                segment_count = len(active.get("strava_segments") or []) if isinstance(active, dict) else 0
            if segment_count:
                route_state += f"；已保存 {segment_count} 个 Strava 路段样本"
            candidate_state = "；".join(
                _compact_route_candidate_state(index, candidate)
                for index, candidate in enumerate(candidates[:3], start=1)
            )
            planning = route_plan.get("planning") if isinstance(route_plan.get("planning"), dict) else {}
            planning_status = str(planning.get("status") or "legacy")
            confirmed_id = str(planning.get("confirmed_candidate_id") or "-")
            parts.append(
                f"当前路线计划: {route_plan.get('plan_id')} rev{route_plan.get('revision')}；"
                f"当前候选 {active_id or '-'}；Strava策略 {route_plan.get('segment_strategy') or 'ignore'}；"
                f"状态 {planning_status}；已确认候选 {confirmed_id}；{route_state}；"
                f"候选列表: {candidate_state or '-'}"
            )
    workflow = last_workflow_result(context)
    if workflow:
        workflow_id = str(workflow.get("workflow_id") or "")
        status = str(workflow.get("status") or "unknown")
        if workflow_id:
            parts.append(f"最近工作流: {workflow_id}（{status}；仅用于衔接刚才的批量操作）")
    report_job = last_report_job(context)
    if report_job:
        parts.append(
            f"最近报告任务: {report_job.get('job_id')}（{report_job.get('status')}；"
            f"{report_job.get('completed', 0)}/{report_job.get('total', 0)}）"
        )
    return "\n".join(["[本轮状态]", *parts]) if parts else ""


def _compact_route_candidate_state(index: int, candidate: dict[str, Any]) -> str:
    segments = [
        str(item.get("name") or item.get("segment_id") or "")
        for item in candidate.get("strava_segments") or [] if isinstance(item, dict)
    ]
    return (
        f"{index}.{candidate.get('candidate_id') or '-'} "
        f"{candidate.get('name') or '-'} {candidate.get('distance_km') or 0}km "
        f"类型={candidate.get('candidate_kind') or 'baseline'} "
        f"路段={'+'.join(segments) or '无'}"
    )


def _compact_route_stage_state(stage: dict[str, Any]) -> str:
    points = [point for point in stage.get("waypoints") or [] if isinstance(point, dict)]
    names = [str(point.get("name") or point.get("query") or "") for point in points]
    return (
        f"{stage.get('stage_id') or '-'} {stage.get('label') or '阶段'}"
        f"({' → '.join(names) or '-'})"
    )


def last_workflow_result(context: AgentContext) -> dict[str, Any] | None:
    """Return the latest persisted workflow result from compact context state."""
    last = context.last_tool_result or {}
    if last.get("step_name") not in {
        "run_activity_workflow",
        "sync_and_run_activity_workflow",
        "get_activity_workflow",
        "retry_activity_workflow",
    }:
        return None
    result = last.get("result")
    return result if isinstance(result, dict) and result.get("workflow_id") else None


def last_report_job(context: AgentContext) -> dict[str, Any] | None:
    """Return the last observed durable report job; fresh status requires the get tool."""
    last = context.last_tool_result or {}
    if last.get("step_name") not in {"rebuild_activity_reports", "get_activity_report_job", "cancel_activity_report_job"}:
        return None
    result = last.get("result")
    return result if isinstance(result, dict) and result.get("job_id") else None
