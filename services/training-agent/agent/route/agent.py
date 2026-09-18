"""Route-only model loop. Never invokes the complete Main Agent."""
from copy import deepcopy
import json

from agent.main_agent.context import AgentContext
from agent.main_agent.execution_policy import TurnExecutionPolicy
from agent.main_agent.hooks import ToolLoopHooks
from agent.main_agent.result_builder import build_completed_result, build_activation_unavailable_result, build_llm_unavailable_result
from agent.runtime.loop_engine import execute_tool_loop
from agent.skills import get_skill, load_skill_instructions
from dataclasses import replace
from agent.tools import MAIN_AGENT_TOOLS, render_anthropic_tools
from agent.tools.registry import TOOL_HANDLERS
from integrations.llm import AnthropicMessagesClient, LLMRequestError
from storage.repositories.route import RoutePlanStore
from services.route.view import build_route_plan_view
from agent.route.contracts import RouteTaskInput, project_task_result

CLARIFY = "request_route_clarification"
MAX_ROUTE_STEPS = 6


class RouteHooks(ToolLoopHooks):
    def on_blocked(self, block, blocked, *, step_count):
        super().on_blocked(block, blocked, step_count=step_count)
        self.stop_after_tool_round = True

    def _guard_tool_call(self, block):
        if block.get("name") == CLARIFY:
            question = (block.get("input") or {}).get("question")
            if not isinstance(question, str) or not question.strip():
                return {"reason": "澄清问题不能为空。"}
            return None
        return super()._guard_tool_call(block)

    def post_tool_use(self, block, output, *, step_count):
        super().post_tool_use(block, output, step_count=step_count)
        self.stop_after_tool_round = True


def run_route_agent(task: RouteTaskInput, *, history=None, client=None):
    context = AgentContext(
        session_id=f"route:{task.request_id}", workspace_id=task.workspace_id,
        request_id=task.request_id, messages=deepcopy(history or []),
        active_skill_id="plan-routes", route_request_options=deepcopy(task.options),
    )
    context.messages.append({"role": "user", "content": task.message})
    policy = TurnExecutionPolicy.route_plan(task.action)
    plan = RoutePlanStore().get(task.plan_id) if task.plan_id else None
    if task.plan_id and (not plan or plan.get("workspace_id") != task.workspace_id or plan.get("revision") != task.revision):
        return project_task_result({"status": "failed", "answer": "路线版本已变化或不属于当前工作区，请刷新。", "error": {
            "code": "route_reference_conflict", "stage": "route_reference", "retryable": False,
            "message": "路线版本已变化或不属于当前工作区，请刷新。",
        }}, task), deepcopy(context.messages)
    names = set(policy.completion_tool_names) | {CLARIFY}
    tools = render_anthropic_tools([tool for tool in MAIN_AGENT_TOOLS if tool.name in names])
    tools.append({"name": CLARIFY, "description": "缺少地区或必要信息时询问用户；不得猜测地点。", "input_schema": {
        "type": "object", "properties": {"question": {"type": "string", "minLength": 1}}, "required": ["question"],
    }})

    def clarify(args, ctx):
        return {"status": "clarification_required", "answer": args["question"]}

    def update(args, ctx):
        if not task.plan_id:
            raise ValueError("修改路线需要当前计划引用")
        if args.get("operation") in {"confirm_candidate", "select_candidate"}:
            raise ValueError("预览和确认请使用页面命令")
        return TOOL_HANDLERS["update_route_plan"]({**args, "plan_id": task.plan_id, "_expected_revision": task.revision}, ctx)

    handlers = {name: TOOL_HANDLERS[name] for name in names if name != CLARIFY}
    handlers[CLARIFY] = clarify
    if "update_route_plan" in names:
        handlers["update_route_plan"] = update
    steps = []
    hooks = RouteHooks(context, {tool.category for tool in MAIN_AGENT_TOOLS if tool.name in names},
                       {"value": False}, steps, allowed_tool_names=names, stop_on_failed_tools=names)
    system = load_skill_instructions(replace(get_skill("plan-routes"), library_path="route/execute-routes.md")) + "\n这是独立路线任务。缺少地区时调用 request_route_clarification。不得把模型文字当执行成功。确认由页面命令完成。"
    if plan:
        system += "\n当前计划（只用于本任务）：" + json.dumps(build_route_plan_view(plan), ensure_ascii=False)
    try:
        client = client or AnthropicMessagesClient()
    except (RuntimeError, ValueError) as exc:
        return project_task_result(build_activation_unavailable_result(context, error=exc, execution_policy=policy), task), deepcopy(context.messages)
    try:
        count = execute_tool_loop(context.messages, tools=tools, handlers=handlers, runtime=hooks,
                                  system=system, max_tokens=4096, max_steps=MAX_ROUTE_STEPS,
                                  client=client, tool_choice={"type": "any"})
        if context.execution_trace and context.execution_trace[-1].get("tool") == CLARIFY and context.execution_trace[-1].get("status") != "blocked":
            result = {"status": "clarification_required", "answer": context.execution_trace[-1]["result"]["answer"]}
        else:
            result = build_completed_result("route_advice", context, task.message, step_count=count,
                                            max_tool_steps=MAX_ROUTE_STEPS, steps=steps, execution_policy=policy)
    except LLMRequestError as exc:
        result = build_llm_unavailable_result("route_advice", context, steps=steps, error=exc, execution_policy=policy)
    for record in reversed(context.execution_trace):
        if record.get("tool") in policy.completion_tool_names and record.get("status") != "blocked":
            result["_route_action"] = "create" if record["tool"] == "create_route_plan" else "update"
            result["_route_action_executed"] = True
            break
    # Persist plain dialogue only: no tool authorization or mutable parent state.
    dialogue = []
    for message in context.messages:
        content = message.get("content")
        if isinstance(content, str):
            dialogue.append(deepcopy(message))
    dialogue.append({"role": "assistant", "content": str(result.get("answer") or "")})
    return project_task_result(result, task), dialogue[-24:]
