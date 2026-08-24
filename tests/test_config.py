from __future__ import annotations

import pytest

from settings import (
    _extract_top_level_yaml_block,
    cfg_bool,
    cfg_get,
    ensure_data_dirs,
    get_agent_config,
    load_agent_config,
    load_config,
)


class TestLoadConfig:
    def test_loads_valid_config(self, temp_config_file):
        config = load_config(temp_config_file)
        assert config["garmin_username"] == "test@qq.com"
        assert config["agent"]["base_url"] == "https://api.test.com/anthropic"

    def test_nonexistent_file_returns_empty(self):
        config = load_config("/tmp/nonexistent_config.yaml")
        assert config == {}


class TestConfigHelpers:
    def test_cfg_get_treats_empty_as_default(self):
        assert cfg_get({"value": ""}, "value", "fallback") == "fallback"
        assert cfg_get({"value": None}, "value", "fallback") == "fallback"
        assert cfg_get({"value": "ok"}, "value", "fallback") == "ok"

    def test_cfg_bool_accepts_common_string_values(self):
        assert cfg_bool({"enabled": "yes"}, "enabled") is True
        assert cfg_bool({"enabled": "off"}, "enabled") is False
        assert cfg_bool({}, "enabled", default=True) is True


class TestLoadAgentConfig:
    def test_loads_agent_block(self, temp_config_file):
        agent_config = load_agent_config(temp_config_file)
        assert agent_config["base_url"] == "https://api.test.com/anthropic"
        assert agent_config["api_key"] == "sk-test-key-123"
        assert agent_config["model"] == "test-model"

    def test_nonexistent_file_returns_empty(self):
        config = load_agent_config("/tmp/nonexistent_config.yaml")
        assert config == {}


class TestGetAgentConfig:
    def test_normalizes_fields(self, temp_config_file):
        agent_config = load_agent_config(temp_config_file)
        result = get_agent_config({"agent": agent_config})
        assert result["provider"] == "anthropic"
        assert result["model"] == "test-model"
        assert result["max_tokens"] == 2000
        assert result["temperature"] == 0.5

    def test_default_values(self):
        result = get_agent_config({})
        assert result["provider"] == "anthropic"
        assert result["max_tokens"] == 1200
        assert result["temperature"] == 0.3
        assert result["max_retries"] == 2
        assert result["timeout_seconds"] == 300
        assert result["thinking"] is None
        assert result["reasoning_effort"] is None

    def test_normalizes_reasoning_controls(self):
        result = get_agent_config({
            "agent": {"thinking": "ENABLED", "reasoning_effort": "LOW"},
        })

        assert result["thinking"] == "enabled"
        assert result["reasoning_effort"] == "low"

    def test_rejects_unknown_reasoning_effort(self):
        with pytest.raises(ValueError, match="agent.reasoning_effort"):
            get_agent_config({"agent": {"reasoning_effort": "medium"}})


class TestExtractTopLevelYamlBlock:
    def test_extracts_agent_block(self):
        yaml_text = """
garmin_username: test

agent:
  base_url: https://api.test.com
  api_key: sk-123

strava:
  client_id: "456"
"""
        result = _extract_top_level_yaml_block(yaml_text, "agent")
        assert "base_url" in result
        assert "garmin_username" not in result
        assert "strava" not in result

    def test_key_not_found_returns_empty(self):
        result = _extract_top_level_yaml_block("foo: bar", "nonexistent")
        assert result == ""

    def test_handles_comments(self):
        yaml_text = """
# some comment
agent:
  # indented comment
  base_url: https://api.test.com
"""
        result = _extract_top_level_yaml_block(yaml_text, "agent")
        assert "base_url" in result


class TestEnsureDataDirs:
    def test_creates_directories(self, tmp_path):
        result = ensure_data_dirs(tmp_path)
        assert result["root"] == tmp_path
        assert result["root"].exists()
        assert result["root"].is_dir()
