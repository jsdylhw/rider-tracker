"""LLM API 客户端:Anthropic Messages API 兼容接口.

当前通过 DeepSeek 的 /anthropic 端点使用,兼容 Anthropic Messages API 格式.
重试仅针对 timeout/URLError/IncompleteRead,HTTP 错误直接抛出(不做无意义重试).
"""

from __future__ import annotations

import json
import random
import socket
import time
from http.client import BadStatusLine, IncompleteRead, RemoteDisconnected
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from settings import get_agent_config


class LLMRequestError(RuntimeError):
    """LLM 请求在重试耗尽后仍不可用。

    调用方可据此保留 Agent 上下文并返回可恢复的用户提示，而不是让 CLI
    直接打印 traceback 后退出。
    """


class AnthropicMessagesClient:
    """Anthropic Messages API 兼容的 LLM 客户端.

    支持单条消息(create_message)和多轮对话(create_messages)两种模式.
    配置从 config.yaml 的 agent: 块读取.
    """

    def __init__(self, config: dict[str, Any] | None = None):
        self.config = get_agent_config() if config is None else get_agent_config({"agent": config})
        self.base_url = str(self.config.get("base_url") or "").rstrip("/")
        self.api_key = str(self.config.get("api_key") or "")
        self.model = str(self.config.get("model") or "")
        if not self.base_url:
            raise RuntimeError("Please set agent.base_url in config.yaml")
        if not self.api_key:
            raise RuntimeError("Please set agent.api_key in config.yaml")
        if not self.model:
            raise RuntimeError("Please set agent.model in config.yaml")

    def _messages_url(self) -> str:
        if self.base_url.endswith("/v1/messages"):
            return self.base_url
        return f"{self.base_url}/v1/messages"

    def create_message(
        self, *, system: str | None = None, user: str | list[dict[str, Any]],
        max_tokens: int | None = None, temperature: float | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: dict[str, Any] | None = None,
        thinking: str | None = None,
    ) -> dict[str, Any]:
        """单条 user 消息调用(guided/direct 模式使用)."""
        payload = {
            "model": self.model,
            "max_tokens": max_tokens or self.config["max_tokens"],
            "temperature": self.config["temperature"] if temperature is None else temperature,
            "messages": [{"role": "user", "content": user}],
        }
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = tools
        if tool_choice:
            payload["tool_choice"] = tool_choice
        self._apply_reasoning_config(payload, thinking=thinking)
        return self._post_messages(payload)

    def create_messages(
        self, *, system: str | None = None, messages: list[dict[str, Any]],
        max_tokens: int | None = None, temperature: float | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: dict[str, Any] | None = None,
        thinking: str | None = None,
    ) -> dict[str, Any]:
        """多轮 messages 调用(tool loop 模式使用)."""
        payload = {
            "model": self.model,
            "max_tokens": max_tokens or self.config["max_tokens"],
            "temperature": self.config["temperature"] if temperature is None else temperature,
            "messages": messages,
        }
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = tools
        if tool_choice:
            payload["tool_choice"] = tool_choice
        self._apply_reasoning_config(payload, thinking=thinking)
        return self._post_messages(payload)

    def _apply_reasoning_config(self, payload: dict[str, Any], *, thinking: str | None = None) -> None:
        """Map local settings to DeepSeek's Anthropic-compatible controls.

        The fields stay absent when they are not configured so other
        Anthropic-compatible providers keep their existing request contract.
        """
        effective_thinking = thinking if thinking is not None else self.config.get("thinking")
        if effective_thinking:
            payload["thinking"] = {"type": effective_thinking}

        # Effort is meaningful only while thinking is enabled. Omitting it for
        # disabled mode also avoids sending a contradictory provider request.
        reasoning_effort = self.config.get("reasoning_effort")
        if effective_thinking != "disabled" and reasoning_effort:
            payload["output_config"] = {"effort": reasoning_effort}

    def _post_messages(self, payload: dict[str, Any]) -> dict[str, Any]:
        """发送 POST 请求到 Messages API.

        对网络中断、限流和服务端错误做有限指数退避重试；认证和请求参数错误
        则立即失败。LLM 请求本身没有外部业务副作用，因此可以安全重发。
        """
        request = Request(
            self._messages_url(),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "x-api-key": self.api_key,
                "anthropic-version": str(self.config["anthropic_version"]),
            },
            method="POST",
        )
        timeout = float(self.config.get("timeout_seconds") or 300)
        max_retries = max(1, int(self.config.get("max_retries") or 1))
        last_error: BaseException | None = None

        started = time.perf_counter()
        for attempt in range(1, max_retries + 1):
            try:
                with urlopen(request, timeout=timeout) as response:
                    result = json.loads(response.read().decode("utf-8"))
                _record_llm_observation(
                    model=self.model,
                    started=started,
                    attempts=attempt,
                    success=True,
                    usage=result.get("usage") if isinstance(result, dict) else None,
                )
                return result
            except HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                if exc.code not in {408, 425, 429} and not 500 <= exc.code <= 599:
                    message = f"LLM request failed: HTTP {exc.code}; body={body[:1000]}"
                    _record_llm_observation(
                        model=self.model,
                        started=started,
                        attempts=attempt,
                        success=False,
                        error=message,
                    )
                    raise LLMRequestError(message) from exc
                last_error = exc
                retry_after = _retry_after_seconds(exc)
            except (
                TimeoutError, socket.timeout, IncompleteRead, URLError,
                RemoteDisconnected, BadStatusLine, ConnectionError, OSError,
            ) as exc:
                last_error = exc
                retry_after = None

            if attempt < max_retries:
                time.sleep(_retry_delay_seconds(attempt, retry_after=retry_after))

        message = (
            f"LLM request timed out or failed after {max_retries} attempt(s); "
            f"timeout_seconds={timeout}; error={last_error}"
        )
        _record_llm_observation(
            model=self.model,
            started=started,
            attempts=max_retries,
            success=False,
            error=message,
        )
        raise LLMRequestError(message) from last_error


def _record_llm_observation(
    *,
    model: str,
    started: float,
    attempts: int,
    success: bool,
    usage: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    """Emit metrics only when an evaluation trace is active."""
    from observability import record_llm_call

    record_llm_call(
        model=model,
        duration_ms=(time.perf_counter() - started) * 1000,
        attempts=attempts,
        success=success,
        usage=usage,
        error=error,
    )


def _retry_after_seconds(error: HTTPError) -> float | None:
    value = error.headers.get("Retry-After") if error.headers else None
    try:
        return max(0.0, min(float(value), 60.0)) if value is not None else None
    except (TypeError, ValueError):
        return None


def _retry_delay_seconds(attempt: int, *, retry_after: float | None) -> float:
    """有限指数退避，加微小抖动避免多个客户端同时重试。"""
    base = retry_after if retry_after is not None else min(float(2 ** (attempt - 1)), 10.0)
    return base + random.uniform(0.0, 0.25)


def extract_text(message: dict[str, Any]) -> str:
    """从 API 响应中提取 text content,跳过 tool_use 等非文本 block.

    Args:
        message: Anthropic Messages API 的响应 dict.

    Returns:
        str: 拼接所有 text block 的内容.
    """
    parts = message.get("content") or []
    texts = [
        str(part.get("text"))
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text" and part.get("text") is not None
    ]
    return "\n".join(texts).strip()


def extract_tool_use_blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    """从 API 响应中提取所有 tool_use content block.

    每个 block 包含 id, name, input 字段.

    Args:
        message: Anthropic Messages API 的响应 dict.

    Returns:
        list[dict]: tool_use block 列表.
    """
    parts = message.get("content") or []
    return [
        {
            "id": part.get("id"),
            "name": part.get("name"),
            "input": part.get("input") or {},
        }
        for part in parts
        if isinstance(part, dict) and part.get("type") == "tool_use"
    ]


def build_tool_result_block(tool_use_id: str, content: str) -> dict[str, Any]:
    """构建 tool_result content block,用于追加到 messages.

    Args:
        tool_use_id: tool_use block 的 id.
        content: 工具执行结果的 JSON 字符串.

    Returns:
        dict: {"type": "tool_result", "tool_use_id": ..., "content": ...}
    """
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": content,
    }
