"""Route-only model loop. Never invokes the complete Main Agent."""
from copy import deepcopy
import json

from agent.main_agent.context import AgentContext
from agent.main_agent.execution_policy import TurnExecutionPolicy
from agent.main_agent.hooks import ToolLoopHooks
from agent.main_agent.result_builder import build_completed_result, build_activation_unavailable_result, build_llm_unavailable_result
from agent.runtime.loop_engine import execute_tool_loop
from agent.main_agent.tool_result import is_failed_tool_output
from agent.skills import get_skill, load_skill_instructions
from dataclasses import replace
from agent.tools import MAIN_AGENT_TOOLS, render_anthropic_tools
from agent.tools.registry import TOOL_HANDLERS
from integrations.llm import AnthropicMessagesClient, LLMRequestError
from storage.repositories.route import RoutePlanStore
from services.route.view import build_route_plan_view
from agent.route.contracts import RouteTaskInput, project_task_result

CLARIFY = "request_route_clarification"
MAX_ROUTE_STEPS = 8
SEARCH = "search_cycling_routes"
PREPARE = "prepare_route_materials"


class RouteHooks(ToolLoopHooks):
    search_calls = 0
    preparation_calls = 0
    material_corrections = 0
    searched_this_round = False

    on_progress = None

    def emit_progress(self, stage, status):
        if self.on_progress:
            self.on_progress({"stage": stage, "status": status})

    def before_llm_call(self):
        self.emit_progress("reasoning", "running")
        return super().before_llm_call()

    def on_tool_round(self):
        self.searched_this_round = False

    def pre_tool_use(self, block, *, step_count):
        if self.searched_this_round:
            return {"status": "deferred", "code": "route_requires_next_round", "reason": "先阅读搜索或材料准备结果，再在下一模型轮调用工具。"}
        if block.get("name") == "create_route_plan" and ((block.get("input") or {}).get("use_prepared_candidates") or self.preparation_calls or self.material_corrections) and not self.context.route_preparation:
            return {"reason": "没有成功准备的材料，不能创建。请根据准备错误修正材料；预算已尽时澄清，不能报告生成成功。"}
        if block.get("name") == PREPARE and self.material_corrections >= 3:
            return {"reason": "材料修正已达三次上限，请澄清必要信息。"}
        if block.get("name") == PREPARE and self.preparation_calls >= 2:
            return {"reason": "本轮材料准备次数已达 2 次上限。"}
        if block.get("name") == SEARCH and self.search_calls >= 2:
            return {"reason": "本轮搜索次数已达 2 次上限，请使用已有资料规划或澄清。"}
        blocked = super().pre_tool_use(block, step_count=step_count)
        if not blocked:
            self.emit_progress(block.get("name"), "running")
        return blocked

    def on_blocked(self, block, blocked, *, step_count):
        if blocked.get("code") == "route_requires_next_round":
            # Scheduling deferral is not a failed business operation.
            self.stop_after_tool_round = False
            return
        super().on_blocked(block, blocked, step_count=step_count)
        self.stop_after_tool_round = not (self.searched_this_round or block.get("name") in {SEARCH, PREPARE, "create_route_plan"})

    def _guard_tool_call(self, block):
        if block.get("name") == CLARIFY:
            question = (block.get("input") or {}).get("question")
            if not isinstance(question, str) or not question.strip():
                return {"reason": "澄清问题不能为空。"}
            return None
        return super()._guard_tool_call(block)

    def post_tool_use(self, block, output, *, step_count):
        super().post_tool_use(block, output, step_count=step_count)
        if (block.get("name") == PREPARE and isinstance(output, dict)
                and output.get("status") == "prepared" and self.context.route_preparation):
            # A corrected material draft replaces earlier invalid drafts in this task.
            # Keep their diagnostics in the trace, but do not treat them as pending failures.
            for record in self.context.execution_trace[:-1]:
                if (record.get("tool") == PREPARE and record.get("status") == "failed"
                        and record.get("code") == "route_materials_invalid"):
                    record["status"] = "recovered"
        self.emit_progress(block.get("name"), "failed" if is_failed_tool_output(output) else "completed")
        if block.get("name") in {SEARCH, PREPARE}:
            self.search_calls += int(block.get("name") == SEARCH)
            if block.get("name") == PREPARE:
                invalid = isinstance(output, dict) and output.get("code") == "route_materials_invalid"
                self.material_corrections += int(invalid)
                self.preparation_calls += int(not invalid)
            self.searched_this_round = True
            self.stop_after_tool_round = False
            if block.get("name") == PREPARE and isinstance(output, dict) and output.get("status") == "failed":
                # Preserve the actual final failure, not a later budget Guard rejection.
                self.stop_after_tool_round = self.preparation_calls >= 2 or self.material_corrections >= 3
        else:
            self.stop_after_tool_round = True


def run_route_agent(task: RouteTaskInput, *, history=None, client=None, on_progress=None):
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
    regenerate = task.action == "refine" and plan is not None
    if task.action == "refine":
        policy = TurnExecutionPolicy.route_plan("create")
    names = set(policy.completion_tool_names) | {CLARIFY, SEARCH, PREPARE}
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
    if regenerate:
        context.route_base_plan = deepcopy(plan)
        context.route_research = deepcopy(plan.get("research_sources") or [])
        def regenerate_plan(args, ctx):
            options = dict(args)
            replacing = ((ctx.route_preparation or {}).get("requirement_changes") or {}).get("mode") == "replace"
            for key in ("route_constraints", "route_preferences"):
                inherited = {} if replacing else (plan.get(key) or {})
                options[key] = {**inherited, **(args.get(key) or {})}
            return TOOL_HANDLERS["create_route_plan"]({**options, "use_prepared_candidates": True}, ctx)
        handlers["create_route_plan"] = regenerate_plan
    handlers[CLARIFY] = clarify
    if "update_route_plan" in names:
        handlers["update_route_plan"] = update
    steps = []
    hooks = RouteHooks(context, {tool.category for tool in MAIN_AGENT_TOOLS if tool.name in names},
                       {"value": False}, steps, allowed_tool_names=names, stop_on_failed_tools=policy.completion_tool_names, terminal_tool_names=policy.completion_tool_names)
    hooks.on_progress = on_progress
    system = load_skill_instructions(replace(get_skill("plan-routes"), library_path="route/execute-routes.md")) + "\n这是独立路线任务。缺少地区时调用 request_route_clarification。不得把模型文字当执行成功。确认由页面命令完成。"
    if plan:
        view = build_route_plan_view(plan)
        if regenerate:
            selected = next((c for c in view["candidates"] if c["candidate_id"] == view["active_candidate_id"]), None)
            if selected is None:
                return project_task_result({"status": "failed", "answer": "当前选中路线已变化，请重新选择。", "error": {"code": "route_reference_conflict", "message": "当前选中路线已变化，请重新选择。"}}, task), deepcopy(context.messages)
            system += "\n本轮为候选重新生成：以以下服务端选中路线及用户修改为基准，保留未被否定的起点、距离目标和约束；若明确换地区则使用新地区。重新提交完整 materials，准备三种不同骨架，再 create_route_plan(use_prepared_candidates=true)。不要只改一个候选。少于三条通过时如实报告。"
            system += "\n选中路线与原约束：" + json.dumps({"candidate": selected,
                "materials": (plan.get("route_preparation") or {}).get("materials"),
                "route_constraints": plan.get("route_constraints"), "route_preferences": plan.get("route_preferences")}, ensure_ascii=False)
        else:
            system += "\n当前计划（只用于本任务）：" + json.dumps(view, ensure_ascii=False)
    try:
        client = client or AnthropicMessagesClient()
    except (RuntimeError, ValueError) as exc:
        return project_task_result(build_activation_unavailable_result(context, error=exc, execution_policy=policy), task), deepcopy(context.messages)
    try:
        count = execute_tool_loop(context.messages, tools=(lambda: [t for t in tools if not (regenerate and not context.route_preparation and t["name"] == "create_route_plan")]), handlers=handlers, runtime=hooks,
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
