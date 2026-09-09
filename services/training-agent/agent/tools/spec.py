"""统一工具定义:ToolDef + ToolRegistry + renderers.

所有 LLM 可调用工具都使用 ToolDef 定义，通过 renderer 转为不同 API 格式。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# 工具类别
CATEGORY_FIT_QUERY = "fit_query"          # FIT 只读数据查询
CATEGORY_OPERATION = "operation"           # 有副作用的操作(sync/upload)
CATEGORY_CONVERSATION = "conversation"     # 闲聊/追问
CATEGORY_ACTIVITY_SELECTION = "activity_selection"   # 活动定位
CATEGORY_ANALYSIS = "analysis"             # 分析/汇总/对比
CATEGORY_COACHING = "coaching"             # 训练建议/路线建议
CATEGORY_WORKFLOW = "workflow"             # 持久化活动工作流
CATEGORY_SKILL = "skill"                   # 仅用于本轮 Skill 激活


@dataclass(frozen=True)
class ToolDef:
    """LLM 可调用工具的唯一定义格式.

    所有工具统一使用此格式定义,再通过 renderer 转为 Anthropic / OpenAI 原生 tools 参数.
    """

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    category: str = CATEGORY_FIT_QUERY

    def to_anthropic(self) -> dict[str, Any]:
        """转为 Anthropic Messages API tools 参数格式(实例方法,兼容旧调用)."""
        return render_anthropic_tool(self)


# -- 工具注册表 ----------------------------------------------------------

class ToolRegistry:
    """按 name 和 category 索引的工具注册表."""

    def __init__(self, tools: tuple[ToolDef, ...] = ()):
        self._by_name: dict[str, ToolDef] = {}
        self._by_category: dict[str, list[ToolDef]] = {}
        for tool in tools:
            self.add(tool)

    def add(self, tool: ToolDef) -> None:
        self._by_name[tool.name] = tool
        self._by_category.setdefault(tool.category, []).append(tool)

    def get(self, name: str) -> ToolDef | None:
        return self._by_name.get(name)

    def by_category(self, category: str) -> list[ToolDef]:
        return list(self._by_category.get(category, []))

    def all(self) -> list[ToolDef]:
        return list(self._by_name.values())

    def to_anthropic(self) -> list[dict[str, Any]]:
        """导出全部工具为 Anthropic tools 参数格式."""
        return render_anthropic_tools(self._by_name.values())

    def to_anthropic_by_category(self, *categories: str) -> list[dict[str, Any]]:
        """按类别过滤后导出."""
        tools: list[ToolDef] = []
        for cat in categories:
            tools.extend(self.by_category(cat))
        return render_anthropic_tools(tools)

    def __len__(self) -> int:
        return len(self._by_name)

    def __contains__(self, name: str) -> bool:
        return name in self._by_name


# -- Renderers -----------------------------------------------------------

def render_anthropic_tool(tool: ToolDef) -> dict[str, Any]:
    """单个 ToolDef → Anthropic API tools 元素."""
    return {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.input_schema or {"type": "object", "properties": {}},
    }


def render_anthropic_tools(tools: Any) -> list[dict[str, Any]]:
    """ToolDef 可迭代对象 → Anthropic API tools 参数."""
    return [render_anthropic_tool(t) for t in tools]
