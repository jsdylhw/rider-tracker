from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from agent.main_agent.context import AgentContext
from integrations.llm import AnthropicMessagesClient
from agent.main_agent.hooks import ToolLoopHooks
from agent.main_agent.loop import agent_loop
from observability import capture_agent_trace, record_tool_call


def test_trace_aggregates_nested_usage_and_tool_events():
    with capture_agent_trace(metadata={"case_id": "trace"}) as trace:
        record_tool_call(
            name="resolve_activities",
            arguments={"limit": 1},
            output={"status": "completed"},
            duration_ms=2.5,
            success=True,
        )
        from observability import record_llm_call

        record_llm_call(
            model="test-model",
            duration_ms=10,
            attempts=1,
            success=True,
            usage={"input_tokens": 120, "output_tokens": 30, "cache_read_input_tokens": 50},
        )

    payload = trace.to_dict()
    assert payload["metadata"]["case_id"] == "trace"
    assert payload["usage"] == {
        "input_tokens": 120,
        "output_tokens": 30,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 50,
        "total_tokens": 200,
    }
    assert payload["tool_calls"][0]["name"] == "resolve_activities"
    assert payload["elapsed_ms"] >= 0


@patch("integrations.llm.urlopen")
def test_llm_client_records_api_usage_only_inside_active_trace(mock_urlopen):
    response = MagicMock()
    response.read.return_value = json.dumps({
        "id": "msg-trace",
        "content": [{"type": "text", "text": "ok"}],
        "usage": {"input_tokens": 17, "output_tokens": 5},
    }).encode("utf-8")
    mock_urlopen.return_value.__enter__.return_value = response
    client = AnthropicMessagesClient({
        "base_url": "https://api.test.com/anthropic",
        "api_key": "sk-test",
        "model": "trace-model",
    })

    with capture_agent_trace() as trace:
        client.create_message(user="hello")

    assert trace.usage_totals()["total_tokens"] == 22
    assert trace.llm_calls[0]["model"] == "trace-model"
    assert trace.llm_calls[0]["success"] is True


def test_agent_loop_records_safe_tool_output_in_trace():
    class FakeClient:
        def __init__(self):
            self.responses = iter([
                {
                    "content": [{"type": "tool_use", "id": "tu-1", "name": "casual_chat", "input": {"answer": "你好"}}],
                    "stop_reason": "tool_use",
                },
                {"content": [{"type": "text", "text": "你好"}], "stop_reason": "end_turn"},
            ])

        def create_messages(self, **kwargs):
            return next(self.responses)

    context = AgentContext(session_id="trace-loop")
    steps: list[dict] = []
    hooks = ToolLoopHooks(context, {"conversation"}, {"value": False}, steps)
    with capture_agent_trace() as trace:
        agent_loop(
            [{"role": "user", "content": "你好"}],
            tools=[{"name": "casual_chat", "description": "chat", "input_schema": {"type": "object"}}],
            handlers={"casual_chat": lambda args, ctx: {"status": "completed", "answer": args["answer"]}},
            hooks=hooks,
            client=FakeClient(),
        )

    assert trace.tool_calls[0]["name"] == "casual_chat"
    assert trace.tool_calls[0]["output"]["answer"] == "你好"
    assert trace.tool_calls[0]["success"] is True
