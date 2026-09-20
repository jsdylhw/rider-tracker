"""Fixed route stages. Tool payload vocabulary stays at this adapter boundary."""
from copy import deepcopy

from agent.main_agent.tool_result import is_failed_tool_output
from storage.repositories.route_workflow import RouteWorkflowStore


STAGES = ("research", "materials", "routing")
TOOL_STAGE = {"search_cycling_routes": "research", "prepare_route_materials": "materials",
              "create_route_plan": "routing", "update_route_plan": "routing",
              "create_itinerary_plan": "routing"}


class RouteWorkflow:
    def __init__(self, context):
        self.context = context
        self.snapshot = {"schema_version": "route_workflow.v1", "workspace_id": context.workspace_id,
                         "request_id": context.request_id, "status": "running",
                         "stages": {stage: {"state": "pending", "attempts": 0} for stage in STAGES}}
        self.persist()

    def persist(self):
        RouteWorkflowStore().save(self.snapshot)

    def start(self, tool):
        stage = TOOL_STAGE.get(tool)
        if stage is None:
            return
        # Any replacement invalidates downstream evidence before external I/O.
        for following in STAGES[STAGES.index(stage) + 1:]:
            self.snapshot["stages"][following] = {"state": "pending", "attempts": 0}
        if stage == "research":
            self.context.route_preparation = None
        current = self.snapshot["stages"][stage]
        self.snapshot["stages"][stage] = {"state": "running", "attempts": current["attempts"] + 1}
        self.persist()

    def finish(self, tool, output, record):
        stage = TOOL_STAGE.get(tool)
        if stage is None:
            return
        current = self.snapshot["stages"][stage]
        failed = is_failed_tool_output(output)
        expected = {"research": "ok", "materials": "prepared", "routing": "completed"}[stage]
        completed = isinstance(output, dict) and output.get("status") == expected and not failed
        if stage == "materials":
            completed = completed and bool(self.context.route_preparation)
        if stage == "routing":
            completed = completed and bool((output.get("result") or {}).get("plan_id"))
        current.update(state="completed" if completed else "blocked")
        current["record"] = deepcopy(record)
        if completed:
            if stage == "research":
                current["artifact"] = deepcopy(self.context.route_research)
            elif stage == "materials":
                current["artifact"] = deepcopy(self.context.route_preparation)
            # Direct point-to-point tasks can omit earlier stages, but a failed
            # attempt must be repaired explicitly, never silently skipped.
            for earlier in STAGES[:STAGES.index(stage)]:
                if self.snapshot["stages"][earlier]["state"] == "pending":
                    self.snapshot["stages"][earlier]["state"] = "skipped"
        elif not failed:
            current["record"] = {"tool": tool, "status": "failed", "result": {
                "code": "route_result_missing" if stage == "routing" else "route_stage_result_missing", "stage": stage,
                "message": "路线阶段没有返回完整的执行结果。"}}
        self.persist()

    def blocked(self, tool, record):
        stage = TOOL_STAGE.get(tool)
        if stage:
            current = self.snapshot["stages"][stage]
            # Preserve a provider/material diagnosis when a later budget guard fires.
            if current["state"] != "blocked":
                current.update(state="blocked", record=deepcopy(record))
            self.persist()

    def failure(self):
        for stage in STAGES:
            current = self.snapshot["stages"][stage]
            if current["state"] == "blocked":
                return current["record"]
        return None

    def close(self, result):
        self.snapshot["status"] = ("completed" if result.get("route_task", {}).get("status") == "completed"
                                   else "needs_input" if result.get("status") == "clarification_required" else "interrupted")
        self.snapshot["result"] = deepcopy(result.get("route_task"))
        self.persist()
        # Keep full artifacts in storage, not in the browser protocol.
        return {"schema_version": "route_workflow.v1", "request_id": self.context.request_id,
                "status": self.snapshot["status"], "stages": {
                    stage: {key: current[key] for key in ("state", "attempts")}
                    for stage, current in self.snapshot["stages"].items()}}
