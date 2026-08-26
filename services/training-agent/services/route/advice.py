"""路线建议:基于位置、时长/距离、目标和可选训练状态,由 LLM 生成结构化建议."""

from __future__ import annotations

import json
import re
from typing import Any, Callable

RouteAdvisor = Callable[[str, str], str]


def generate_route_advice(
    *,
    args: dict[str, Any] | None = None,
    training_load: dict[str, Any] | None = None,
    user_message: str = "",
    advisor: RouteAdvisor,
    name: str = "generate_route_advice",
) -> dict[str, Any]:
    """根据用户输入生成骑行路线建议.

    从 args 中提取位置、时长/距离、目标，并接受调用方提供的可选训练负荷，
    调用 LLM 输出结构化建议 + 用户可读的 Markdown 回答.
    """
    args = args or {}
    location = str(args.get("location") or args.get("area") or args.get("place") or "")
    duration = _num_arg(args.get("duration") or args.get("duration_min"))
    distance = _num_arg(args.get("distance") or args.get("distance_km"))
    goal = str(args.get("goal") or args.get("objective") or args.get("target") or "")
    terrain = str(args.get("terrain") or "")
    scenery = str(args.get("scenery") or "")
    preferences = _list_arg(args.get("preferences") or args.get("preference"))

    payload = {
        "user_message": user_message,
        "location": location,
        "duration_min": duration,
        "distance_km": distance,
        "goal": goal,
        "terrain": terrain,
        "scenery": scenery,
        "preferences": preferences,
        "training_load_summary": training_load,
    }

    raw = advisor(
        ROUTE_ADVICE_SYSTEM_PROMPT,
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
    )
    raw = str(raw or "").strip()
    parsed = _parse_structured_response(raw)

    if parsed is None:
        return {
            "step": name,
            "status": "completed",
            "answer": raw or "暂时无法生成路线建议，请确认位置和骑行目标后再试。",
            "result": {
                "kind": "route_advice",
                "error": "unparseable_llm_response",
                "raw": raw,
            },
        }

    return {
        "step": name,
        "status": "completed",
        "answer": _answer_text(parsed, raw),
        "result": {
            "kind": "route_advice",
            "route_request": {
                "location": location,
                "duration_min": duration,
                "distance_km": distance,
                "goal": goal,
                "terrain": terrain,
                "scenery": scenery,
                "preferences": preferences,
                "has_training_load": training_load is not None,
            },
            "strategy": parsed.get("strategy"),
            "constraints": parsed.get("constraints") or [],
            "needs_clarification": parsed.get("needs_clarification", False),
        },
    }


ROUTE_ADVICE_SYSTEM_PROMPT = """你是骑行路线建议助手。根据用户提供的位置、时间/距离、训练目标和可选的近期训练状态，给出中文骑行建议。

你没有地图、天气或实时路况数据。你只能给出路线类型、地形约束和强度建议，不能输出具体道路名称、真实路况或精确方向（如"往东骑到XX路"）。

输出必须是 JSON 对象：

{
  "answer": "用户可读的 Markdown 中文建议，按下面四段组织",
  "strategy": {
    "suitable": "今天是否适合骑行的简短判断",
    "ride_type": "推荐的骑行类型",
    "intensity": "建议强度描述",
    "terrain_preference": "平路 / 起伏 / 爬坡 等",
    "estimated_range": "预估距离或时长范围，如 40-60km / 2-3h"
  },
  "constraints": ["注意事项列表，每条一个字符串，2-4 条，涵盖补给、装备、安全、恢复等"],
  "needs_clarification": false
}

answer 的 Markdown 结构：
## 今天适合骑吗
## 建议骑行类型
## 路线方向建议
## 注意事项

要求：
- 没有地图和天气数据时，路线方向建议只写地形偏好、距离范围和一般性约束（如"选车少路好的平路绕圈"、"找一段连续爬坡再原路返回"），不要写具体道路名、真实路况、具体方向。
- 不要声称某地通常存在骑行道、乡间道路、补给点、低车流路段。可以写成"如果地图确认有骑行道/低车流道路，优先选择"这类条件表述。
- 如果有训练负荷数据，用它判断恢复状态和强度安排。
- 如果没有训练负荷数据，按一般骑行建议给出，可以在注意事项里提醒先分析近期活动。
- needs_clarification 为 true 时表示用户输入不足以给出靠谱建议（如没给位置也没给目标），answer 里追问 1-2 个聚焦问题。
- 使用中文，口语化但专业。
"""


def _num_arg(value: Any) -> float | None:
    """解析参数值为数值,支持 "60km"、"2小时"、2.5、120 等形式.

    - 带 "小时"/"h" 后缀的转为分钟数.
    - 带 "km"/"公里" 后缀的剥离单位.
    - 纯数字直接返回 float.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value).strip()
    if not text:
        return None

    hour_match = re.match(r"^([0-9]+(?:\.[0-9]+)?)\s*(小时|h|hr|hrs)$", text, re.IGNORECASE)
    if hour_match:
        return round(float(hour_match.group(1)) * 60, 1)

    km_match = re.match(r"^([0-9]+(?:\.[0-9]+)?)\s*(公里|km)$", text, re.IGNORECASE)
    if km_match:
        return float(km_match.group(1))

    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def _list_arg(value: Any) -> list[str]:
    """解析列表参数,支持 JSON 字符串和 Python list."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            try:
                data = json.loads(text)
                if isinstance(data, list):
                    return [str(item) for item in data]
            except json.JSONDecodeError:
                pass
        return [text]
    return [str(value)]


def _answer_text(parsed: dict[str, Any], raw: str) -> str:
    """提取用户可读的 answer 文本,缺省时返回兜底消息."""
    answer = str(parsed.get("answer") or "").strip()
    if answer:
        return answer
    return "已生成路线建议。"


def _parse_structured_response(raw: str) -> dict[str, Any] | None:
    """从 LLM 响应中提取结构化 JSON."""
    if not raw:
        return None
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end < start:
            return None
        try:
            data = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError:
            return None
    if not isinstance(data, dict):
        return None
    return data
