from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from agent.main_agent.context import AgentContext
from services.route.advice import _list_arg, _num_arg
from agent.tools.handlers.route import generate_route_advice_tool


def _mock_advice_json(answer: str, *, strategy: dict | None = None, constraints: list | None = None, needs_clarification: bool = False) -> str:
    return json.dumps({
        "answer": answer,
        "strategy": strategy or {
            "suitable": "适合骑行",
            "ride_type": "有氧耐力",
            "intensity": "Z2为主",
            "terrain_preference": "平路绕圈",
            "estimated_range": "40-60km",
        },
        "constraints": constraints or ["补水", "防晒"],
        "needs_clarification": needs_clarification,
    }, ensure_ascii=False)


# -- unit: _num_arg --

@pytest.mark.parametrize("value, expected", [
    (120, 120.0),
    (2.5, 2.5),
    ("60km", 60.0),
    ("60公里", 60.0),
    ("2小时", 120.0),
    ("2h", 120.0),
    ("1.5hrs", 90.0),
    (None, None),
    (True, None),
    ("", None),
    ("latest", None),
])
def test_num_arg(value, expected):
    assert _num_arg(value) == expected


# -- unit: _list_arg --

@pytest.mark.parametrize("value, expected", [
    (None, []),
    (["平坦", "风景好"], ["平坦", "风景好"]),
    ("平坦", ["平坦"]),
    ('["平坦", "风景好"]', ["平坦", "风景好"]),
    (123, ["123"]),
])
def test_list_arg(value, expected):
    assert _list_arg(value) == expected


# -- unit: generate_route_advice --

def test_generate_route_advice_basic():
    context = AgentContext(session_id="test_route_advice")

    with patch("agent.tools.handlers.route.AnthropicMessagesClient") as MockClient:
        mock_client = MockClient.return_value
        mock_client.create_message.return_value = {
            "content": [{"type": "text", "text": _mock_advice_json("## 今天适合骑吗\n适合。\n\n## 建议骑行类型\n有氧耐力，Z2为主。\n\n## 路线方向建议\n平路绕圈。\n\n## 注意事项\n补水、防晒。")}],
        }
        result = generate_route_advice_tool(
            context,
            args={"location": "上海青浦区", "duration": 120, "goal": "有氧耐力"},
        )

    assert result["status"] == "completed"
    assert "有氧耐力" in result["answer"]
    assert result["result"]["schema_version"] == "route_advice.v1"
    assert result["result"]["route_request"]["location"] == "上海青浦区"
    assert result["result"]["route_request"]["duration_min"] == 120
    assert result["result"]["strategy"]["ride_type"] == "有氧耐力"
    assert len(result["result"]["constraints"]) == 2
    assert result["result"]["needs_clarification"] is False


def test_generate_route_advice_with_preferences():
    """tool_use 传入 terrain/scenery/preferences 参数,应保留在 route_request 中."""
    context = AgentContext(session_id="test_prefs")

    with patch("agent.tools.handlers.route.AnthropicMessagesClient") as MockClient:
        mock_client = MockClient.return_value
        mock_client.create_message.return_value = {
            "content": [{"type": "text", "text": _mock_advice_json("## 今天适合骑吗\n适合。")}],
        }
        result = generate_route_advice_tool(
            context,
            args={
                "location": "意大利湖区",
                "distance": "30km",
                "terrain": "平路",
                "scenery": "风景好",
                "preferences": ["低车流", "沿湖"],
            },
        )

    req = result["result"]["route_request"]
    assert req["terrain"] == "平路"
    assert req["scenery"] == "风景好"
    assert req["preferences"] == ["低车流", "沿湖"]


def test_generate_route_advice_missing_answer_fallback():
    """LLM 返回 JSON 但缺 answer 时,应兜底而不返回空字符串."""
    context = AgentContext(session_id="test_fallback")

    with patch("agent.tools.handlers.route.AnthropicMessagesClient") as MockClient:
        mock_client = MockClient.return_value
        mock_client.create_message.return_value = {
            "content": [{"type": "text", "text": json.dumps({"strategy": {}, "constraints": [], "needs_clarification": False}, ensure_ascii=False)}],
        }
        result = generate_route_advice_tool(context, args={"location": "上海"})

    assert len(result["answer"]) > 0
    assert "已生成路线建议" in result["answer"]


def test_generate_route_advice_with_training_load():
    context = AgentContext(
        session_id="test_route_advice_load",
        last_tool_result={
            "step_name": "summarize_recent_training_load",
            "status": "completed",
            "result": {
                "schema_version": "training_load_summary.v1",
                "activity_count": 3,
                "intensity": {"total_tss": 280, "avg_if": 0.82},
                "recency": {"days_since_last_activity": 1},
            },
        },
    )

    with patch("agent.tools.handlers.route.AnthropicMessagesClient") as MockClient:
        mock_client = MockClient.return_value
        mock_client.create_message.return_value = {
            "content": [{"type": "text", "text": _mock_advice_json(
                "## 今天适合骑吗\n昨天刚骑完，适合恢复骑。",
                strategy={"suitable": "适合但只建议恢复", "ride_type": "恢复骑", "intensity": "Z1", "terrain_preference": "平路", "estimated_range": "20-30km"},
                constraints=["不要爬坡", "昨天负荷偏高"],
            )}],
        }
        result = generate_route_advice_tool(
            context,
            args={"location": "北京昌平", "distance": "50km", "goal": "爬坡"},
        )

    assert result["status"] == "completed"
    assert result["result"]["route_request"]["has_training_load"] is True
    assert result["result"]["route_request"]["distance_km"] == 50.0
    assert result["result"]["strategy"]["ride_type"] == "恢复骑"


def test_generate_route_advice_empty_llm_response():
    context = AgentContext(session_id="test_empty")

    with patch("agent.tools.handlers.route.AnthropicMessagesClient") as MockClient:
        mock_client = MockClient.return_value
        mock_client.create_message.return_value = {"content": [{"type": "text", "text": ""}]}
        result = generate_route_advice_tool(context, args={"location": "上海"})

    assert result["status"] == "completed"
    assert "暂时无法生成" in result["answer"]


def test_generate_route_advice_needs_clarification():
    context = AgentContext(session_id="test_clarify")

    with patch("agent.tools.handlers.route.AnthropicMessagesClient") as MockClient:
        mock_client = MockClient.return_value
        mock_client.create_message.return_value = {
            "content": [{"type": "text", "text": _mock_advice_json(
                "请问你想骑多久、在哪个区域？",
                needs_clarification=True,
            )}],
        }
        result = generate_route_advice_tool(context, args={})

    assert result["result"]["needs_clarification"] is True
