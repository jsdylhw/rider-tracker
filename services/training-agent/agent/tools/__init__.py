"""Agent 工具包 — 所有 LLM 可调用工具的统一定义与导出.

按类型组织:
- spec.py          — ToolDef + ToolRegistry + renderers + 类别常量
- fit_analysis/    — ActivityAnalysisAgent 内部只读 FIT 数据工具
- agent_tools.py   — Main Agent 暴露的粗粒度业务工具
- registry.py      — Main Agent 工具 handler 注册表

确定性 FIT 计算在 fit.analysis 中，子 Agent 的 ToolDef 与 handler 在
agent.tools.fit_analysis 中。
"""

from agent.tools.agent_tools import AGENT_TOOLS, MAIN_AGENT_TOOLS
from agent.tools.fit_analysis import (
    FIT_DATA_TOOLS,
    build_tool_handlers,
    call_fit_analysis_tool,
    fit_analysis_tool_catalog,
    fit_data_tool_catalog,
)
from agent.tools.spec import (
    CATEGORY_ACTIVITY_SELECTION,
    CATEGORY_ANALYSIS,
    CATEGORY_COACHING,
    CATEGORY_CONVERSATION,
    CATEGORY_FIT_QUERY,
    CATEGORY_OPERATION,
    CATEGORY_WORKFLOW,
    ToolDef,
    ToolRegistry,
    render_anthropic_tool,
    render_anthropic_tools,
)
__all__ = [
    # spec
    "CATEGORY_ACTIVITY_SELECTION",
    "CATEGORY_ANALYSIS",
    "CATEGORY_COACHING",
    "CATEGORY_CONVERSATION",
    "CATEGORY_FIT_QUERY",
    "CATEGORY_OPERATION",
    "CATEGORY_WORKFLOW",
    "ToolDef",
    "ToolRegistry",
    "render_anthropic_tool",
    "render_anthropic_tools",
    # fit_query
    "FIT_DATA_TOOLS",
    "build_tool_handlers",
    "call_fit_analysis_tool",
    "fit_analysis_tool_catalog",
    "fit_data_tool_catalog",
    # agent_tools
    "MAIN_AGENT_TOOLS",
    "AGENT_TOOLS",
]
