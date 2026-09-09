from __future__ import annotations

import json
from http.client import IncompleteRead, RemoteDisconnected
from unittest.mock import MagicMock, patch

import pytest

from integrations.llm import AnthropicMessagesClient, extract_text


class TestExtractText:
    def test_extracts_text_parts(self):
        message = {
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "text", "text": "World"},
            ]
        }
        result = extract_text(message)
        assert result == "Hello\nWorld"

    def test_skips_non_text_parts(self):
        message = {
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "tool_use", "name": "get_history"},
                {"type": "text", "text": "World"},
            ]
        }
        result = extract_text(message)
        assert result == "Hello\nWorld"

    def test_empty_content_returns_empty_string(self):
        assert extract_text({"content": []}) == ""
        assert extract_text({}) == ""

    def test_handles_none_text_value(self):
        message = {
            "content": [
                {"type": "text", "text": None},
                {"type": "text", "text": "valid"},
            ]
        }
        result = extract_text(message)
        assert "valid" in result


class TestAnthropicMessagesClientInit:
    """The constructor wraps config in {"agent": config} before calling get_agent_config,
    so we pass flat config dicts to match how callers actually use it."""

    def test_raises_without_base_url(self):
        with pytest.raises(RuntimeError, match="base_url"):
            AnthropicMessagesClient({"api_key": "sk", "model": "m", "base_url": ""})

    def test_raises_without_api_key(self):
        with pytest.raises(RuntimeError, match="api_key"):
            AnthropicMessagesClient({"base_url": "https://api.test.com", "model": "m", "api_key": ""})

    def test_raises_without_model(self):
        with pytest.raises(RuntimeError, match="model"):
            AnthropicMessagesClient({"base_url": "https://api.test.com", "api_key": "sk", "model": ""})

    def test_normalizes_base_url(self):
        client = AnthropicMessagesClient({"base_url": "https://api.test.com/anthropic/", "api_key": "sk", "model": "m"})
        assert client.base_url == "https://api.test.com/anthropic"

    def test_already_ends_with_v1_messages(self):
        client = AnthropicMessagesClient(
            {"base_url": "https://api.test.com/anthropic/v1/messages", "api_key": "sk", "model": "m"}
        )
        assert client._messages_url() == "https://api.test.com/anthropic/v1/messages"


class TestAnthropicMessagesClient:
    @pytest.fixture
    def client(self):
        return AnthropicMessagesClient(
            {"base_url": "https://api.test.com/anthropic", "api_key": "sk-test", "model": "test-model"}
        )

    @patch("integrations.llm.urlopen")
    def test_create_messages_http(self, mock_urlopen, client):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "msg_123",
            "content": [{"type": "text", "text": "Hello back"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        result = client.create_messages(
            system="System prompt",
            messages=[{"role": "user", "content": "Hi"}],
        )
        assert result["id"] == "msg_123"

    @patch("integrations.llm.urlopen")
    def test_call_can_disable_configured_thinking(self, mock_urlopen):
        client = AnthropicMessagesClient({
            "base_url": "https://api.test.com/anthropic",
            "api_key": "sk-test",
            "model": "test-model",
            "thinking": "enabled",
            "reasoning_effort": "low",
        })
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "msg_disabled",
            "content": [{"type": "text", "text": "ok"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client.create_messages(
            messages=[{"role": "user", "content": "Hi"}],
            thinking="disabled",
        )

        request = mock_urlopen.call_args[0][0]
        payload = json.loads(request.data.decode("utf-8"))
        assert payload["thinking"] == {"type": "disabled"}
        assert "output_config" not in payload

    @patch("integrations.llm.urlopen")
    def test_create_message_single(self, mock_urlopen, client):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "msg_single",
            "content": [{"type": "text", "text": "Response"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        result = client.create_message(
            system="System prompt",
            user="Hello",
        )
        assert result["id"] == "msg_single"

    @patch("integrations.llm.urlopen")
    def test_sends_enabled_low_reasoning_controls(self, mock_urlopen):
        client = AnthropicMessagesClient({
            "base_url": "https://api.test.com/anthropic",
            "api_key": "sk-test",
            "model": "test-model",
            "thinking": "enabled",
            "reasoning_effort": "low",
        })
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "msg_reasoning",
            "content": [{"type": "text", "text": "ok"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client.create_message(user="Hello")

        request = mock_urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        assert payload["thinking"] == {"type": "enabled"}
        assert payload["output_config"] == {"effort": "low"}

    @patch("integrations.llm.urlopen")
    def test_disabled_thinking_omits_effort(self, mock_urlopen):
        client = AnthropicMessagesClient({
            "base_url": "https://api.test.com/anthropic",
            "api_key": "sk-test",
            "model": "test-model",
            "thinking": "disabled",
            "reasoning_effort": "low",
        })
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "msg_no_reasoning",
            "content": [{"type": "text", "text": "ok"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client.create_message(user="Hello")

        request = mock_urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        assert payload["thinking"] == {"type": "disabled"}
        assert "output_config" not in payload

    @patch("integrations.llm.time.sleep")
    @patch("integrations.llm.urlopen")
    def test_retries_incomplete_read(self, mock_urlopen, mock_sleep):
        client = AnthropicMessagesClient(
            {
                "base_url": "https://api.test.com/anthropic",
                "api_key": "sk-test",
                "model": "test-model",
                "max_retries": 2,
            }
        )
        broken_response = MagicMock()
        broken_response.read.side_effect = IncompleteRead(b"")
        ok_response = MagicMock()
        ok_response.read.return_value = json.dumps({
            "id": "msg_retry",
            "content": [{"type": "text", "text": "ok"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.side_effect = [broken_response, ok_response]

        result = client.create_message(user="Hello")

        assert result["id"] == "msg_retry"
        assert mock_urlopen.call_count == 2
        mock_sleep.assert_called_once()

    @patch("integrations.llm.time.sleep")
    @patch("integrations.llm.urlopen")
    def test_retries_remote_disconnect(self, mock_urlopen, mock_sleep):
        client = AnthropicMessagesClient(
            {
                "base_url": "https://api.test.com/anthropic",
                "api_key": "sk-test",
                "model": "test-model",
                "max_retries": 2,
            }
        )
        ok_response = MagicMock()
        ok_response.read.return_value = json.dumps({
            "id": "msg-reconnected",
            "content": [{"type": "text", "text": "ok"}],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.side_effect = [
            RemoteDisconnected("peer closed connection"), ok_response,
        ]

        result = client.create_message(user="Hello")

        assert result["id"] == "msg-reconnected"
        assert mock_urlopen.call_count == 2
        mock_sleep.assert_called_once()
