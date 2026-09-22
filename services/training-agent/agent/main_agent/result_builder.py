"""Convert completed runtime state into the public TurnResult contract."""

from __future__ import annotations

from typing import Any
import json

from agent.main_agent.context import AgentContext
from agent.main_agent.execution_policy import ROUTE_RESULT_TOOLS, TurnExecutionPolicy
from agent.runtime.chat_logger import write_main_agent_markdown_log
from agent.runtime.models import TurnResult, executions_from_trace
from agent.runtime.presentation_projector import project_presentations
from services.route.view import build_route_plan_view
from storage.repositories.route import RoutePlanStore
from agent.main_agent.tool_result import is_failed_tool_output


def build_completed_result(
    intent: Any,
    context: AgentContext,
    message: str,
    *,
    step_count: int,
    max_tool_steps: int,
    steps: list[dict[str, Any]],
    execution_policy: TurnExecutionPolicy | None = None,
) -> dict[str, Any]:
    """Build a completed or max-steps result from the current turn only."""
    execution_policy = execution_policy or TurnExecutionPolicy.chat()
    context.last_llm_error = None
    delegation = next((record.get("result") for record in reversed(context.execution_trace)
                       if record.get("tool") == "run_route_agent" and record.get("status") != "blocked"), None)
    if isinstance(delegation, dict) and isinstance(delegation.get("route_task"), dict):
        earlier_failure = _unresolved_failure([record for record in context.execution_trace
                                               if record.get("tool") != "run_route_agent"])
        if earlier_failure is not None:
            return build_policy_unsatisfied_result(context, steps, execution_policy)
        result = build_turn_result(
            delegation["status"], intent, context, steps, delegation.get("answer", ""),
            project_route_plan=False, error=delegation.get("error"),
        )
        context.messages.append({"role": "assistant", "content": str(delegation.get("answer") or "")})
        for key in ("route_task", "route_plan", "route_workflow", "route_operation"):
            if key in delegation:
                result[key] = delegation[key]
        return result
    if step_count > max_tool_steps:
        return build_turn_result(
            "max_steps_exceeded",
            intent,
            context,
            steps,
            f"达到最大步数 ({max_tool_steps}), 已执行 {len(steps)} 步, 但未完成。",
            project_route_plan=execution_policy.is_satisfied(context.execution_trace),
            error={"code": "budget_exhausted", "stage": "tool_loop", "retryable": False,
                   "message": "达到本轮工具调用预算，任务尚未完成。"},
        )

    if not execution_policy.is_satisfied(context.execution_trace):
        return build_policy_unsatisfied_result(context, steps, execution_policy)
    if _context_failure(context) is not None:
        return build_policy_unsatisfied_result(context, steps, execution_policy)

    clarification = next((item.get("result") for item in reversed(context.execution_trace)
                          if item.get("tool") == "ask_user_clarification"
                          and not is_failed_tool_output(item.get("result"))), None)
    if isinstance(clarification, dict):
        return build_turn_result("clarification_required", intent, context, steps,
                                 str(clarification.get("answer") or "请补充操作目标。"))
    from agent.skills import get_skill
    from agent.main_agent.turn_policy import is_terminal_tool_result
    skill = get_skill(context.active_skill_id)
    evidence_required = bool(not execution_policy.completion_tool_names and skill
                             and (skill.allow_side_effects or skill.skill_id == "plan-routes"))
    if evidence_required and not any(
        item.get("tool") in skill.tool_names
        and is_terminal_tool_result(str(item.get("tool") or ""), item.get("result"))
        for item in context.execution_trace
    ):
        answer = "本轮尚未取得操作结果，不能确认下载、发布或路线处理已经完成。请明确操作目标后再试。"
        # Remove ungrounded completion prose from the durable conversation too.
        while context.messages and context.messages[-1].get("role") == "assistant":
            context.messages.pop()
        context.messages.append({"role": "assistant", "content": [{"type": "text", "text": answer}]})
        return build_turn_result("action_not_executed", intent, context, steps, answer,
                                 error={"code": "action_not_executed", "stage": "completion", "retryable": False,
                                        "message": "本轮没有相应业务工具的执行结果。"})

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
    execution_policy: TurnExecutionPolicy | None = None,
) -> dict[str, Any]:
    """Preserve completed tool state when final language generation fails."""
    execution_policy = execution_policy or TurnExecutionPolicy.chat()
    context.last_llm_error = {"type": type(error).__name__, "message": str(error)}
    if not execution_policy.is_satisfied(context.execution_trace):
        return build_turn_result(
            "llm_unavailable", intent, context, steps,
            "模型服务连接失败，本轮要求尚未完成；已保留实际执行记录，请稍后重试。",
            project_route_plan=False,
            error={"code": "llm_unavailable", "stage": "model_request", "retryable": True,
                   "message": "模型服务连接失败，请稍后重试。"},
        )
    workflow_answer = completed_workflow_fallback(context, steps=steps)
    if workflow_answer:
        return build_turn_result("llm_unavailable", intent, context, steps, workflow_answer)
    answer = (
        "LLM 服务连接暂时不可用，已保留本轮活动选择和已执行工具状态。"
        f"本轮已执行 {len(steps)} 步；不会自动执行新的下载、分析或上传。\n\n"
        "请稍后回复“重试”继续。"
    )
    return build_turn_result(
        "llm_unavailable", intent, context, steps, answer,
        error={"code": "llm_unavailable", "stage": "model_request", "retryable": True,
               "message": "模型服务连接失败，请稍后重试。"},
    )


def build_activation_unavailable_result(
    context: AgentContext,
    *,
    error: Exception,
    execution_policy: TurnExecutionPolicy | None = None,
) -> dict[str, Any]:
    """Fail closed when the model client cannot be created."""
    execution_policy = execution_policy or TurnExecutionPolicy.chat()
    context.last_llm_error = {"type": type(error).__name__, "message": str(error)}
    if not execution_policy.is_satisfied(context.execution_trace):
        return build_turn_result(
            "llm_unavailable", "route_advice", context, [],
            "模型客户端初始化失败，本轮尚未执行路线工具。请检查模型配置后重试。",
            project_route_plan=False,
            error={"code": "llm_initialization_failed", "stage": "model_initialization",
                   "retryable": False, "message": "模型客户端初始化失败，请检查模型配置。"},
        )
    context.active_skill_id = None
    answer = "LLM 服务连接暂时不可用，尚未选择领域 Skill，因此本轮没有暴露或执行任何活动工具。请稍后重试。"
    return build_turn_result(
        "llm_unavailable", "skill_activation", context, [], answer,
        error={"code": "llm_initialization_failed", "stage": "model_initialization", "retryable": False,
               "message": "模型客户端初始化失败，请检查模型配置。"},
    )


def _unresolved_failure(trace: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Preparation success cannot recover another operation's failure.

    A later successful replay of the same tool and arguments resolves its
    earlier failure. Different targets remain independent.
    """
    recovered = set()
    for item in reversed(trace):
        if not isinstance(item, dict) or item.get("status") == "recovered":
            continue
        key = (str(item.get("tool") or ""), json.dumps(item.get("input") or {}, sort_keys=True, default=str))
        failed = item.get("status") in {"failed", "blocked"} or is_failed_tool_output(item.get("result"))
        if failed:
            if key not in recovered:
                return item
        elif item.get("status") == "completed":
            recovered.add(key)
    return None


def _context_failure(context):
    if context.route_workflow is not None:
        from agent.route.workflow import TOOL_STAGE
        return context.route_workflow.failure() or _unresolved_failure([
            record for record in context.execution_trace if record.get("tool") not in TOOL_STAGE])
    return _unresolved_failure(context.execution_trace)


def _failure_diagnostic(execution: dict[str, Any]) -> dict[str, Any]:
    payload = execution.get("result") if isinstance(execution.get("result"), dict) else {}
    nested = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    upload = nested.get("upload_result") if isinstance(nested.get("upload_result"), dict) else {}
    sources = [payload, nested, upload, execution]
    diagnostic = {}
    for key in ("code", "provider", "stage", "retryable", "message"):
        value = next((source[key] for source in sources if source.get(key) is not None), None)
        if value is not None:
            diagnostic[key] = value
    diagnostic.setdefault("code", "guard_rejected" if execution.get("status") == "blocked" else "tool_failed")
    diagnostic.setdefault("stage", "guard" if execution.get("status") == "blocked" else "tool_execution")
    diagnostic.setdefault("message", str(payload.get("answer") or "工具执行失败，任务尚未完成。"))
    return diagnostic


def build_policy_unsatisfied_result(
    context: AgentContext,
    steps: list[dict[str, Any]],
    execution_policy: TurnExecutionPolicy,
) -> dict[str, Any]:
    """Return the required tool's structured failure or a missing-action error."""
    result_intent = "route_advice" if execution_policy.request_mode == "route_plan" else "chat"
    failure = _context_failure(context)
    if failure is not None:
        diagnostic = _failure_diagnostic(failure)
        code = str(diagnostic["code"])
        status = (
            "failed" if code == "route_result_missing" else
            "blocked" if code == "guard_rejected" else
            "provider_error" if code.startswith("provider_") or code == "route_provider_error" else
            "route_rejected" if code != "tool_failed" and execution_policy.request_mode == "route_plan" else
            "tool_failed"
        )
        return build_turn_result(
            status,
            result_intent,
            context,
            steps,
            diagnostic["message"],
            project_route_plan=False,
            error=diagnostic,
        )
    return build_turn_result(
        "action_not_executed",
        result_intent,
        context,
        steps,
        ("本轮没有实际执行路线更新，也没有成功生成新路线；"
         "当前已保存路线保持不变。请查看工具失败原因后重试。"
         if execution_policy.request_mode == "route_plan" else
         "本轮未产生满足请求要求的工具结果，请补充说明后重试。"),
        project_route_plan=False,
        error={"code": "action_not_executed", "stage": "completion_check", "retryable": False,
               "message": "本轮未产生满足请求要求的工具结果。"},
    )


def build_turn_result(
    status: str,
    intent: Any,
    context: AgentContext,
    steps: list[dict[str, Any]],
    answer: str,
    log_path: str = "",
    project_route_plan: bool = True,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create the typed result while preserving the legacy dictionary API."""
    executions = executions_from_trace(context.execution_trace, steps=steps)
    result = TurnResult(
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
        error=error,
    ).to_dict()
    route_plan = _route_plan_from_executions(executions) if project_route_plan else None
    if route_plan:
        result["route_plan"] = route_plan
    return result


def _route_plan_from_executions(executions: list[Any]) -> dict[str, Any] | None:
    for execution in reversed(executions):
        if not _is_successful_route_execution(execution):
            continue
        payload = execution.result if isinstance(execution.result, dict) else {}
        if isinstance(payload.get("result"), dict):
            payload = payload["result"]
        plan_id = str(payload.get("plan_id") or "")
        if not plan_id:
            continue
        plan = RoutePlanStore().get(plan_id)
        if plan:
            return build_route_plan_view(plan)
    return None


def _is_successful_route_execution(execution: Any) -> bool:
    """Only successful route executions may project a route plan to the UI."""
    from agent.main_agent.tool_result import is_failed_tool_output
    name = str(getattr(execution, "tool", "") or "")
    result = getattr(execution, "result", None)
    return (
        name in ROUTE_RESULT_TOOLS
        and getattr(execution, "status", None) == "completed"
        and not is_failed_tool_output(result)
    )


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
        "cancel_activity_report_job": "取消报告任务",
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
