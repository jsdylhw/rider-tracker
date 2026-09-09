"""Tool contracts and handlers exposed only to ActivityAnalysisAgent.

Deterministic FIT calculations live in :mod:`fit.analysis`; this package owns
only the LLM-facing schemas and dispatch adapters.
"""

from agent.tools.fit_analysis.catalog import (
    FIT_ANALYSIS_TOOLS,
    FIT_DATA_TOOLS,
    SUBMIT_ANALYSIS_TOOL,
    SUBMIT_QUERY_ANSWER_TOOL,
)
from agent.tools.fit_analysis.handlers import (
    build_tool_handlers,
    call_fit_analysis_tool,
    fit_analysis_tool_catalog,
    fit_data_tool_catalog,
)

__all__ = [
    "FIT_ANALYSIS_TOOLS",
    "FIT_DATA_TOOLS",
    "SUBMIT_ANALYSIS_TOOL",
    "SUBMIT_QUERY_ANSWER_TOOL",
    "build_tool_handlers",
    "call_fit_analysis_tool",
    "fit_analysis_tool_catalog",
    "fit_data_tool_catalog",
]
