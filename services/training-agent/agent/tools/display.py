"""Human-readable CLI labels for tool inputs and outputs."""

from __future__ import annotations

import json
from typing import Any


def format_tool_args(block: dict[str, Any]) -> str:
    name = str(block.get("name") or "")
    args = block.get("input") if isinstance(block.get("input"), dict) else {}
    if name in {"resolve_activities", "lookup_activities"}:
        labels = {
            "recent": "最近活动", "date": "指定日期", "range": "日期范围",
            "current": "当前活动", "all": "全部活动", "key": "活动 ID",
            "index": "活动序号", "name": "活动名称",
        }
        kind = str(args.get("kind") or "")
        parts = [
            "全库最早活动"
            if kind == "all" and args.get("order") == "earliest" and args.get("limit") == 1
            else "全库最长活动"
            if kind == "all" and args.get("order") == "longest" and args.get("limit") == 1
            else labels.get(kind, kind or "未指定范围")
        ]
        if args.get("limit"):
            parts.append(f"{args['limit']} 条")
        if args.get("time_of_day"):
            parts.append(_time_of_day_label(args["time_of_day"]))
        if args.get("date") or args.get("date_local"):
            parts.append(_date_label(args.get("date") or args.get("date_local")))
        if args.get("sport_type"):
            parts.append(str(args["sport_type"]))
        return " · ".join(parts)
    fixed = {
        "summarize_activities": "只读汇总结构化事实和已有报告",
        "inspect_selection": "轻量检查当前活动/集合/片段焦点",
        "analyze_activity": "读取单条完整报告，缺失时生成",
    }
    if name in fixed:
        return fixed[name]
    if name == "find_segments":
        return f"{args.get('segment_type') or 'effort'}" + (f" · 第 {args['ordinal']} 个" if args.get("ordinal") else "")
    if name == "analyze_selection":
        return f"{args.get('objective') or 'inspect_activity'} · {args.get('depth') or 'inspect'}"
    if name == "navigate_selection":
        return f"{args.get('action') or 'current'}" + (f" · 第 {args['ordinal']} 个" if args.get("ordinal") else "")
    if name == "calculate_history_metrics":
        return f"读取结构化指标 · 按 {args.get('group_by') or 'week'} 聚合"
    if name == "analyze_training_history":
        sport = args.get("sport_type") or ("合并运动量" if args.get("combine_sports_for_volume") else "按已选运动类型")
        return f"专业历史分析 · {sport} · 按 {args.get('group_by') or 'week'} 对比"
    if name == "query_activity_detail":
        return f"FIT 定向问题：{str(args.get('question') or '').strip() or '未提供'}"
    if name == "create_route_plan":
        if args.get("segment_strategy") == "complete_loop":
            return f"完整热门环线 · {args.get('origin') or '-'} → {args.get('area') or '-'} → 起点"
        return f"单日路线 · {args.get('country_code') or '-'} · {len(args.get('candidates') or [])} 个候选"
    if name == "create_itinerary_plan":
        stage_count = sum(len(item.get("stages") or []) for item in args.get("candidates") or [] if isinstance(item, dict))
        return f"{args.get('schedule_type') or '分段行程'} · {args.get('country_code') or '-'} · {stage_count} 个阶段"
    if name == "update_route_plan":
        operation = {
            "reverse_candidate": "反转路线", "reverse_stage": "反转阶段",
            "replace_waypoint": "替换途经点", "undo": "撤销路线修改",
        }.get(str(args.get("operation") or ""), args.get("operation") or "更新路线")
        return f"{operation} · {args.get('stage_id') or args.get('candidate_id') or '当前候选'}"
    if name == "get_route_plan":
        return f"路线计划 {args.get('plan_id') or '最近一份'}"
    if name == "explore_route_segments":
        target = args.get("stage_id") or args.get("candidate_id") or "当前路线"
        return f"Strava 路段 · {target} · {args.get('corridor_km') or 5} km 走廊"
    if name == "sync_garmin_activities":
        return f"最近 {args.get('count') or 5} 条 · 仅下载并更新索引"
    if name in {"run_activity_workflow", "sync_and_run_activity_workflow"}:
        goals = ", ".join(str(goal) for goal in args.get("goals") or ["ensure_summary"])
        return f"{args.get('count') or args.get('limit') or 5} 条活动 · {goals}"
    if name in {"get_activity_workflow", "retry_activity_workflow"}:
        return f"工作流 {args.get('workflow_id') or '未提供'}"
    if name == "rebuild_activity_reports":
        return f"后台重建 V2 报告 · {args.get('scope') or 'all'}"
    if name == "get_activity_report_job":
        return f"报告任务 {args.get('job_id') or '未提供'}"
    return ", ".join(f"{key}={json.dumps(value, ensure_ascii=False)}" for key, value in args.items()) or "no args"


def summarize_tool_output(name: str, output: Any) -> str:
    if not isinstance(output, dict):
        return "已完成"
    nested = output.get("result") if isinstance(output.get("result"), dict) else {}
    payload = nested or output
    if output.get("error"):
        return f"未完成：{output.get('message') or output.get('error')}"
    if name in {"resolve_activities", "lookup_activities"}:
        activities = payload.get("activities") if isinstance(payload.get("activities"), list) else []
        labels = "；".join(_activity_label(item) for item in activities[:3] if isinstance(item, dict))
        return f"找到 {payload.get('count', len(activities))} 条活动" + (f"：{labels}" if labels else "")
    if name in {"analyze_activity", "query_activity_detail"}:
        return {
            "existing_summary": "已读取已有报告", "generated_summary": "已生成完整报告",
            "targeted_query": "已完成 FIT 定向查询", "analysis_agent_error": "分析引擎返回降级报告",
        }.get(str(payload.get("source") or ""), "已完成活动分析")
    if name == "summarize_activities":
        coverage = payload.get("report_coverage") if isinstance(payload.get("report_coverage"), dict) else {}
        return (
            f"已只读汇总 {payload.get('count', 0)} 条活动"
            f"（已有报告 {coverage.get('available_count', 0)} 条，缺失 {coverage.get('missing_count', 0)} 条）"
        )
    if name == "find_segments":
        return f"已定位 {payload.get('count', 0)} 个 {payload.get('segment_type') or '片段'}"
    if name in {"inspect_selection", "analyze_selection"}:
        analysis = payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
        target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
        return f"已分析 {len(target.get('activity_ids') or [])} 条活动（{analysis.get('status') or output.get('status') or 'completed'}）"
    if name == "navigate_selection":
        focus = payload.get("current_focus") if isinstance(payload.get("current_focus"), dict) else {}
        return f"当前焦点：{focus.get('type') or 'none'}"
    if name == "calculate_history_metrics":
        coverage = payload.get("coverage") if isinstance(payload.get("coverage"), dict) else {}
        return f"已计算 {coverage.get('included_activity_count', 0)} 条活动的历史指标（{payload.get('group_by') or 'week'}）"
    if name == "analyze_training_history":
        coverage = payload.get("coverage") if isinstance(payload.get("coverage"), dict) else {}
        conclusion = payload.get("conclusion") if isinstance(payload.get("conclusion"), dict) else {}
        return f"已分析 {coverage.get('activity_count', 0)} 条活动（{conclusion.get('assessment') or 'insufficient_data'}，置信度 {conclusion.get('confidence') or 'low'}）"
    if name in {"create_route_plan", "create_itinerary_plan", "update_route_plan", "get_route_plan"}:
        candidates = payload.get("candidates") if isinstance(payload.get("candidates"), list) else []
        active_id = payload.get("active_candidate_id")
        active = next((item for item in candidates if item.get("candidate_id") == active_id), candidates[0] if candidates else {})
        return f"路线 {payload.get('title') or ''}：{active.get('distance_km') or 0} km / {active.get('duration_min') or 0} 分钟"
    if name == "explore_route_segments":
        return f"找到 {payload.get('segment_count', 0)} 个 Strava 热门骑行路段样本"
    if name == "sync_garmin_activities":
        return f"同步完成：下载 {int(payload.get('downloaded') or 0)} 条，跳过 {int(payload.get('skipped') or 0)} 条，失败 {int(payload.get('failed') or 0)} 条；未分析"
    if name in {"run_activity_workflow", "sync_and_run_activity_workflow", "retry_activity_workflow"}:
        return f"工作流 {output.get('workflow_id') or payload.get('workflow_id') or ''}：{output.get('status') or payload.get('status') or 'completed'}".rstrip("：")
    if name in {"rebuild_activity_reports", "get_activity_report_job"}:
        return f"报告任务 {payload.get('job_id') or ''}：{payload.get('status') or 'unknown'}（{int(payload.get('completed') or 0)}/{int(payload.get('total') or 0)}）"
    if "status" in output:
        return f"完成：{output.get('status')}"
    analysis_error = nested.get("analysis_error") if isinstance(nested.get("analysis_error"), dict) else None
    return f"分析异常：{analysis_error.get('type')}" if analysis_error else "已完成"


def tool_label(name: str) -> str:
    return {
        "resolve_activities": "定位活动", "lookup_activities": "临时查询活动", "find_segments": "定位活动片段",
        "inspect_selection": "初步检查", "analyze_selection": "分析当前焦点", "navigate_selection": "切换分析焦点",
        "analyze_activity": "查看活动报告", "query_activity_detail": "查询 FIT 细节", "summarize_activities": "汇总活动",
        "compare_activities": "对比活动", "calculate_history_metrics": "计算历史指标", "analyze_training_history": "分析训练历史",
        "create_route_plan": "创建单日路线", "create_itinerary_plan": "创建分段行程",
        "update_route_plan": "更新路线", "get_route_plan": "查看路线",
        "explore_route_segments": "查询 Strava 路段",
        "sync_garmin_activities": "同步 Garmin 活动", "sync_and_run_activity_workflow": "同步并处理活动",
        "run_activity_workflow": "处理本地活动", "get_activity_workflow": "查看工作流", "retry_activity_workflow": "重试工作流",
        "rebuild_activity_reports": "重建 V2 报告", "get_activity_report_job": "查看报告任务",
    }.get(name, name)


def _time_of_day_label(value: Any) -> str:
    return {"morning": "上午", "afternoon": "下午", "evening": "晚上", "night": "夜间"}.get(str(value), str(value))


def _date_label(value: Any) -> str:
    return {"today": "今天", "yesterday": "昨天"}.get(str(value).lower(), str(value))


def _activity_label(activity: dict[str, Any]) -> str:
    started = str(activity.get("start_time_local") or activity.get("date_local") or "未知时间")
    name = str(activity.get("summary_label") or activity.get("file_name") or activity.get("activity_key") or "活动")
    return f"{started} {name}"
