from __future__ import annotations

from agent.main_agent.context import AgentContext
from agent.main_agent.tool_result import is_failed_tool_output, remember_failed_action


def test_detects_nested_upload_error_as_failed():
    output = {
        "result": {
            "upload_result": {
                "error": "SSLError",
                "message": "network failed",
            },
        },
    }

    assert is_failed_tool_output(output) is True


def test_remember_failed_action_clears_after_same_workflow_tool_succeeds():
    context = AgentContext(session_id="tool-result-test")

    remember_failed_action(context, "retry_activity_workflow", {"workflow_id": "run-1"}, {"error": "SSLError"})
    assert context.last_failed_action == {
        "tool": "retry_activity_workflow",
        "input": {"workflow_id": "run-1"},
    }

    remember_failed_action(context, "retry_activity_workflow", {"workflow_id": "run-1"}, {"status": "completed"})
    assert context.last_failed_action is None
