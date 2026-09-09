"""Side-effect-free handlers used by live model evaluations."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from agent.main_agent.context import AgentContext
from agent.tools.agent_tools import MAIN_AGENT_TOOLS
from evaluation.schema import EvalCase


class EvaluationSandbox:
    """Return realistic tool results without touching Garmin, Strava, or disk state."""

    def __init__(self, case: EvalCase):
        self.case = case
        self._call_counts: dict[str, int] = {}

    def handlers(self) -> dict[str, Callable[[dict[str, Any], AgentContext], dict[str, Any]]]:
        return {tool.name: self._handler(tool.name) for tool in MAIN_AGENT_TOOLS}

    def _handler(self, name: str) -> Callable[[dict[str, Any], AgentContext], dict[str, Any]]:
        def execute(arguments: dict[str, Any], context: AgentContext) -> dict[str, Any]:
            self._call_counts[name] = self._call_counts.get(name, 0) + 1
            output = self._configured_output(name)
            if output is None:
                output = _default_output(name, arguments)
            if name == "resolve_activities" and not output.get("error"):
                activities = _activities_from_output(output)
                context.selected_activities = activities
                if activities and activities[0].get("fit_path"):
                    context.current_fit_file = Path(str(activities[0]["fit_path"]))
            return output

        return execute

    def _configured_output(self, name: str) -> dict[str, Any] | None:
        configured = self.case.tool_outputs.get(name)
        if configured is None:
            return None
        if isinstance(configured, list):
            index = min(self._call_counts.get(name, 1) - 1, len(configured) - 1)
            configured = configured[index]
        if not isinstance(configured, dict):
            raise ValueError(f"tool output for {name} must be an object or object list")
        return deepcopy(configured)


def _default_output(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    activity = {
        "activity_key": "eval-activity-1",
        "fit_path": "/evaluation/fixtures/eval-activity.fit",
        "summary_path": "/evaluation/fixtures/eval-activity.summary.json",
        "start_time_local": "2026-07-29T08:36:38",
        "sport_type": "cycling",
        "summary_label": "评测晨骑",
        "distance_km": 9.25,
        "duration_min": 23.6,
    }
    if name == "resolve_activities":
        limit = max(1, int(arguments.get("limit") or 1))
        activities = [{**activity, "activity_key": f"eval-activity-{index + 1}"} for index in range(limit)]
        return {
            "status": "completed",
            "result": {
                "kind": "activity_selection",
                "request": dict(arguments),
                "count": limit,
                "activities": activities,
            },
        }
    if name == "query_activity_detail":
        return {
            "status": "completed",
            "answer": "100–200 秒区间没有持续冲刺，最高连续高功率段为 12 秒、305 W。",
            "result": {"source": "targeted_query", "facts": {"duration_s": 12, "power_w": 305}},
        }
    if name == "analyze_activity":
        return {"status": "completed", "answer": "已读取活动报告。", "result": {"source": "existing_summary"}}
    if name == "summarize_activities":
        return {
            "status": "completed",
            "answer": "已汇总活动，全部复用已有报告。",
            "result": {"count": 3, "summary_generation": {"generated_count": 0, "skipped_count": 3}},
        }
    if name == "compare_activities":
        return {"status": "completed", "answer": "已完成活动对比。", "result": {"count": 2}}
    if name == "sync_garmin_activities":
        return {
            "status": "completed",
            "downloaded": 2,
            "skipped": 1,
            "failed": 0,
            "activities": [],
        }
    if name in {"sync_and_run_activity_workflow", "run_activity_workflow", "retry_activity_workflow"}:
        goals = list(arguments.get("goals") or ["ensure_summary"])
        return {
            "status": "completed",
            "workflow_id": "eval-workflow-1",
            "request": {"goals": goals, "force_upload": bool(arguments.get("force_upload"))},
            "tasks": [{"kind": goal, "status": "completed"} for goal in goals],
        }
    if name == "get_activity_workflow":
        return {"status": "completed", "workflow_id": arguments.get("workflow_id") or "eval-workflow-1", "tasks": []}
    if name == "casual_chat":
        return {"status": "completed", "answer": str(arguments.get("answer") or "你好！")}
    if name == "ask_user_clarification":
        return {"status": "completed", "answer": str(arguments.get("question") or "请补充活动范围。")}
    if name == "summarize_recent_training_load":
        return {"status": "completed", "answer": "最近训练负荷稳定。", "result": {"tss": 42.0}}
    if name == "calculate_history_metrics":
        return {
            "status": "completed",
            "result": {
                "kind": "training_history_metrics",
                "group_by": arguments.get("group_by") or "week",
                "coverage": {"included_activity_count": 8, "missing_activity_count": 0},
                "comparison": {
                    "previous_period": "2026-W29",
                    "current_period": "2026-W30",
                    "changes": {
                        "distance_km": {"previous": 60, "current": 72, "percent_change": 20.0},
                    },
                },
            },
        }
    if name == "analyze_training_history":
        return {
            "status": "completed",
            "result": {
                "kind": "training_history_analysis",
                "coverage": {"activity_count": 8, "comparable_session_count": 0},
                "conclusion": {
                    "assessment": "mixed", "confidence": "low",
                    "summary": "训练量可比较，但缺少匹配训练证据。",
                },
                "dimensions": [],
                "view": {"type": "training_history"},
            },
        }
    if name == "generate_training_advice":
        return {"status": "completed", "answer": "建议安排轻松恢复骑。"}
    if name == "generate_route_advice":
        return {"status": "completed", "answer": "建议选择低交通平路有氧路线。"}
    return {"status": "completed"}


def _activities_from_output(output: dict[str, Any]) -> list[dict[str, Any]]:
    payload = output.get("result") if isinstance(output.get("result"), dict) else output
    activity = payload.get("activity") if isinstance(payload, dict) else None
    activities = payload.get("activities") if isinstance(payload, dict) else None
    if isinstance(activity, dict):
        return [activity]
    if isinstance(activities, list):
        return [item for item in activities if isinstance(item, dict)]
    return []
