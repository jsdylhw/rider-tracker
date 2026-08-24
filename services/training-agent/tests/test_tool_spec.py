from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from agent.tools.spec import (
    CATEGORY_ACTIVITY_SELECTION,
    CATEGORY_FIT_QUERY,
    CATEGORY_OPERATION,
    ToolDef,
    ToolRegistry,
)


# -- ToolDef ------------------------------------------------------------

class TestToolDef:
    def test_minimal_tool(self):
        t = ToolDef(name="ping", description="Test tool.")
        assert t.name == "ping"
        assert t.category == CATEGORY_FIT_QUERY

    def test_to_anthropic(self):
        t = ToolDef(
            name="get_data",
            description="Return data.",
            input_schema={
                "type": "object",
                "properties": {"key": {"type": "string"}},
                "required": ["key"],
            },
            category=CATEGORY_FIT_QUERY,
        )
        a = t.to_anthropic()
        assert a["name"] == "get_data"
        assert "Return data" in a["description"]
        assert a["input_schema"]["required"] == ["key"]

    def test_to_anthropic_empty_schema_defaults_to_empty_object(self):
        t = ToolDef(name="no_args", description="No args.")
        a = t.to_anthropic()
        assert a["input_schema"] == {"type": "object", "properties": {}}


# -- ToolRegistry --------------------------------------------------------

SAMPLE_TOOLS = (
    ToolDef(name="get_overview", description="Overview.", category=CATEGORY_FIT_QUERY),
    ToolDef(name="get_summary", description="Summary.", category=CATEGORY_FIT_QUERY),
    ToolDef(name="resolve_activities", description="Resolve.", category=CATEGORY_ACTIVITY_SELECTION),
    ToolDef(name="sync", description="Sync.", category=CATEGORY_OPERATION),
)


class TestToolRegistry:
    @pytest.fixture
    def registry(self):
        return ToolRegistry(SAMPLE_TOOLS)

    def test_get(self, registry):
        assert registry.get("get_summary") is not None
        assert registry.get("nonexistent") is None

    def test_by_category(self, registry):
        fit = registry.by_category(CATEGORY_FIT_QUERY)
        assert len(fit) == 2
        names = {t.name for t in fit}
        assert names == {"get_overview", "get_summary"}

    def test_all(self, registry):
        assert len(registry.all()) == 4

    def test_contains(self, registry):
        assert "get_summary" in registry
        assert "nope" not in registry

    def test_to_anthropic(self, registry):
        result = registry.to_anthropic()
        assert len(result) == 4
        assert all("name" in t and "input_schema" in t for t in result)

    def test_to_anthropic_by_category(self, registry):
        result = registry.to_anthropic_by_category(CATEGORY_FIT_QUERY, CATEGORY_OPERATION)
        assert len(result) == 3

    def test_empty_registry(self):
        r = ToolRegistry()
        assert len(r) == 0
        assert r.all() == []

    def test_add(self):
        r = ToolRegistry()
        r.add(ToolDef(name="new", description="New tool."))
        assert "new" in r


# -- AnthropicMessagesClient tools parameter -----------------------------

class TestClientToolsParam:
    @patch("integrations.llm.urlopen")
    def test_create_message_sends_tools(self, mock_urlopen):
        from integrations.llm import AnthropicMessagesClient

        client = AnthropicMessagesClient({
            "base_url": "https://api.test.com/anthropic",
            "api_key": "sk-test",
            "model": "test-model",
        })
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "msg_1",
            "content": [{"type": "text", "text": "ok"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        tools = [{"name": "ping", "description": "Test.", "input_schema": {"type": "object", "properties": {}}}]
        client.create_message(user="Hi", tools=tools)

        call_args = mock_urlopen.call_args[0][0]
        sent = json.loads(call_args.data.decode("utf-8"))
        assert "tools" in sent
        assert sent["tools"] == tools

    @patch("integrations.llm.urlopen")
    def test_create_message_without_tools_omits_key(self, mock_urlopen):
        from integrations.llm import AnthropicMessagesClient

        client = AnthropicMessagesClient({
            "base_url": "https://api.test.com/anthropic",
            "api_key": "sk-test",
            "model": "test-model",
        })
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "msg_2",
            "content": [{"type": "text", "text": "ok"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client.create_message(user="Hi")
        call_args = mock_urlopen.call_args[0][0]
        sent = json.loads(call_args.data.decode("utf-8"))
        assert "tools" not in sent

    @patch("integrations.llm.urlopen")
    def test_create_messages_sends_tools(self, mock_urlopen):
        from integrations.llm import AnthropicMessagesClient

        client = AnthropicMessagesClient({
            "base_url": "https://api.test.com/anthropic",
            "api_key": "sk-test",
            "model": "test-model",
        })
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "msg_3",
            "content": [{"type": "text", "text": "ok"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        tools = [{"name": "get_data", "description": "...", "input_schema": {"type": "object", "properties": {}}}]
        client.create_messages(messages=[{"role": "user", "content": "Hi"}], tools=tools)

        call_args = mock_urlopen.call_args[0][0]
        sent = json.loads(call_args.data.decode("utf-8"))
        assert "tools" in sent


# -- extract_tool_use helpers --------------------------------------------

class TestExtractToolUse:
    def test_extracts_tool_use_blocks(self):
        from integrations.llm import extract_tool_use_blocks

        message = {
            "content": [
                {"type": "text", "text": "Let me check."},
                {"type": "tool_use", "id": "tu_1", "name": "get_data", "input": {"key": "val"}},
                {"type": "text", "text": "Done."},
            ]
        }
        blocks = extract_tool_use_blocks(message)
        assert len(blocks) == 1
        assert blocks[0]["name"] == "get_data"
        assert blocks[0]["input"] == {"key": "val"}

    def test_no_tool_use_returns_empty(self):
        from integrations.llm import extract_tool_use_blocks

        message = {"content": [{"type": "text", "text": "Just text."}]}
        assert extract_tool_use_blocks(message) == []

    def test_build_tool_result_block(self):
        from integrations.llm import build_tool_result_block

        block = build_tool_result_block("tu_1", '{"result": "ok"}')
        assert block["type"] == "tool_result"
        assert block["tool_use_id"] == "tu_1"
        assert block["content"] == '{"result": "ok"}'
