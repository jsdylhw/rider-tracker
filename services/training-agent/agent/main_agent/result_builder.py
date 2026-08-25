"""Convert completed runtime state into the public TurnResult contract."""

from __future__ import annotations

from typing import Any

from agent.main_agent.context import AgentContext
from agent.runtime.chat_logger import write_main_agent_markdown_log
from agent.runtime.models import TurnResult, executions_from_trace
from agent.runtime.presentation_projector import project_presentations


def build_completed_result(
    intent: Any,
    context: AgentContext,
    message: str,
    *,
    step_count: int,
    max_tool_steps: int,
    steps: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build a completed or max-steps result from the current turn only."""
    context.last_llm_error = None
    if step_count > max_tool_steps:
        return build_turn_result(
            "max_steps_exceeded",
            intent,
            context,
            steps,
            f"达到最大步数 ({max_tool_steps}), 已执行 {len(steps)} 步, 但未完成。",
        )

    if not context.execution_trace:
        from agent.main_agent.turn_policy import should_continue_route_skill

        if should_continue_route_skill(message, context):
            return build_turn_result(
                "action_not_executed",
                "route_advice",
                context,
                steps,
                "本轮没有实际执行路线更新，当前已保存路线保持不变。请重试这次修改。",
            )

    final_answer = _current_terminal_answer(context)
    if not final_answer:
        for item in context.messages:
            if item.get("role") != "assistant":
                continue
            for block in item.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text":
                    final_answer = str(block.get("text") or "")
    log_path = write_main_agent_markdown_log(
        context.session_id,
        user_message=message,
        tool_plan={"intent": intent_kind(intent), "skill_id": context.active_skill_id},
        execution={"status": "completed", "steps": steps, "step_results": context.execution_trace},
        selected_activities=context.selected_activities,
        selected_activity_range=context.selected_activity_range,
        current_fit_file=str(context.current_fit_file) if context.current_fit_file else None,
    )
    answer = with_execution_header(final_answer or "已完成。", context=context, steps=steps)
    return build_turn_result("completed", intent, context, steps, answer, str(log_path))


def _current_terminal_answer(context: AgentContext) -> str:
    """Return a complete answer produced by a terminal tool this turn."""
    from agent.main_agent.turn_policy import is_terminal_tool_result

    for execution in reversed(context.execution_trace):
        if not isinstance(execution, dict):
            continue
        result = execution.get("result")
        if not is_terminal_tool_result(str(execution.get("tool") or ""), result):
            continue
        if isinstance(result, dict):
            answer = str(result.get("answer") or "").strip()
            if answer:
                return answer
    return ""


def build_llm_unavailable_result(
    intent: Any,
    context: AgentContext,
    *,
    steps: list[dict[str, Any]],
    error: Exception,
) -> dict[str, Any]:
    """Preserve completed tool state when final language generation fails."""
    context.last_llm_error = {"type": type(error).__name__, "message": str(error)}
    workflow_answer = completed_workflow_fallback(context, steps=steps)
    if workflow_answer:
        return build_turn_result("llm_unavailable", intent, context, steps, workflow_answer)
    answer = (
        "LLM 服务连接暂时不可用，已保留本轮活动选择和已执行工具状态。"
        f"本轮已执行 {len(steps)} 步；不会自动执行新的下载、分析或上传。\n\n"
        "请稍后回复“重试”继续。"
    )
    return build_turn_result("llm_unavailable", intent, context, steps, answer)


def build_activation_unavailable_result(context: AgentContext, *, error: Exception) -> dict[str, Any]:
    """Fail closed when the model client cannot be created."""
    context.last_llm_error = {"type": type(error).__name__, "message": str(error)}
    context.active_skill_id = None
    answer = "LLM 服务连接暂时不可用，尚未选择领域 Skill，因此本轮没有暴露或执行任何活动工具。请稍后重试。"
    return build_turn_result("llm_unavailable", "skill_activation", context, [], answer)


def build_turn_result(
    status: str,
    intent: Any,
    context: AgentContext,
    steps: list[dict[str, Any]],
    answer: str,
    log_path: str = "",
) -> dict[str, Any]:
    """Create the typed result while preserving the legacy dictionary API."""
    executions = executions_from_trace(context.execution_trace, steps=steps)
    return TurnResult(
        answer=answer,
        status=status,
        context=context,
        intent=intent_kind(intent),
        skill_id=context.active_skill_id,
        executions=executions,
        presentations=project_presentations(executions),
        selected_activities=context.selected_activities,
        current_fit_file=str(context.current_fit_file) if context.current_fit_file else None,
        log_path=log_path,
    ).to_dict()


def intent_kind(intent: Any) -> str:
    """Return a stable public intent label from legacy or string inputs."""
    return intent.kind.value if hasattr(intent, "kind") else str(intent)


def with_execution_header(
    answer: str,
    *,
    context: AgentContext,
    steps: list[dict[str, Any]],
) -> str:
    """Prefix the answer with a concise account of actual business tools."""
    text = str(answer).strip()
    if not steps:
        return text
    if text.startswith("已处理："):
        # The model may echo an obsolete header containing an internal key.
        # Execution headers are owned by this deterministic result builder.
        _, separator, remainder = text.partition("\n")
        text = remainder.lstrip() if separator else ""
    sync_tools = {"sync_garmin_activities", "sync_and_run_activity_workflow"}
    current_sync = any(str(step.get("tool") or "") in sync_tools for step in steps)
    current_activities = context.selected_activities
    if current_sync:
        synced_keys: set[str] = set()
        for execution in context.execution_trace:
            if not isinstance(execution, dict) or execution.get("tool") not in sync_tools:
                continue
            result = execution.get("result")
            if not isinstance(result, dict):
                continue
            synced_keys.update(
                str(item.get("activity_key") or "")
                for item in result.get("activities") or []
                if isinstance(item, dict) and item.get("activity_key")
            )
        current_activities = [
            item for item in context.selected_activities
            if isinstance(item, dict) and str(item.get("activity_key") or "") in synced_keys
        ]
    activity_labels: list[str] = []
    for activity in current_activities[:3]:
        if not isinstance(activity, dict):
            continue
        started = activity.get("start_time_local") or activity.get("date_local")
        # activity_key is an internal content identifier, not a user-facing name.
        label = activity.get("summary_label") or activity.get("file_name")
        display_label = " ".join(str(value) for value in (started, label) if value)
        if display_label:
            activity_labels.append(display_label)
    if activity_labels:
        target = "；".join(activity_labels)
        if len(current_activities) > len(activity_labels):
            target += f" 等 {len(current_activities)} 条"
    elif current_activities:
        target = "当前活动" if len(current_activities) == 1 else f"当前 {len(current_activities)} 条活动"
    elif current_sync:
        target = "本次 Garmin 同步"
    else:
        target = "本次请求"
    labels = {
        "resolve_activities": "定位活动",
        "find_segments": "定位片段",
        "inspect_selection": "初步检查",
        "analyze_selection": "分析当前焦点",
        "navigate_selection": "切换焦点",
        "analyze_activity": "读取活动报告",
        "query_activity_detail": "查询 FIT 细节",
        "summarize_activities": "汇总已有报告",
        "compare_activities": "对比活动",
        "calculate_history_metrics": "计算历史指标",
        "analyze_training_history": "分析训练历史",
        "sync_garmin_activities": "同步 Garmin 活动",
        "sync_and_run_activity_workflow": "同步并处理活动",
        "run_activity_workflow": "处理本地活动",
        "retry_activity_workflow": "重试工作流",
        "rebuild_activity_reports": "后台重建 V2 报告",
        "get_activity_report_job": "查看报告任务",
    }
    operations = [labels.get(str(step.get("tool") or ""), str(step.get("tool") or "")) for step in steps]
    compact_operations: list[str] = []
    for operation in operations:
        if operation and operation not in compact_operations:
            compact_operations.append(operation)
    header = f"已处理：{target}｜{' → '.join(compact_operations)}"
    return f"{header}\n\n{text}" if text else header


def completed_workflow_fallback(
    context: AgentContext,
    *,
    steps: list[dict[str, Any]],
) -> str | None:
    """Report only a workflow completed by the current interrupted turn."""
    workflow_tools = {
        "sync_and_run_activity_workflow",
        "run_activity_workflow",
        "get_activity_workflow",
        "retry_activity_workflow",
    }
    current_tools = {
        str(step.get("tool") or "")
        for step in steps
        if isinstance(step, dict)
    }
    if not current_tools.intersection(workflow_tools):
        return None
    workflow = None
    for execution in reversed(context.execution_trace):
        if not isinstance(execution, dict) or execution.get("tool") not in current_tools:
            continue
        result = execution.get("result")
        if isinstance(result, dict) and result.get("workflow_id"):
            workflow = result
            break
    if not workflow or workflow.get("status") not in {"completed", "partial"}:
        return None
    task_counts: dict[str, int] = {}
    for task in workflow.get("tasks") or []:
        if isinstance(task, dict):
            status = str(task.get("status") or "unknown")
            task_counts[status] = task_counts.get(status, 0) + 1
    details: list[str] = []
    sync = workflow.get("sync")
    if isinstance(sync, dict):
        details.append(
            f"同步：下载 {int(sync.get('downloaded') or 0)} 条，跳过 {int(sync.get('skipped') or 0)} 条"
        )
    if task_counts:
        details.append(
            "任务：" + "，".join(
                f"{label} {task_counts.get(status, 0)}"
                for status, label in (("completed", "完成"), ("skipped", "跳过"), ("failed", "失败"))
                if task_counts.get(status, 0)
            )
        )
    summary = "；".join(details) or "所有已规划任务均已完成"
    status_text = "工作流已完成" if workflow.get("status") == "completed" else "工作流部分完成"
    return (
        f"{status_text}：{workflow['workflow_id']}。{summary}。\n\n"
        "LLM 仅在生成最终说明时连接中断；不会重复执行同步、分析或上传。"
    )
