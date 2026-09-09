"""FIT 分析子 Agent 的数据查询与完成协议工具定义."""

from __future__ import annotations

from agent.tools.spec import CATEGORY_ANALYSIS, CATEGORY_FIT_QUERY, ToolDef

FIT_DATA_TOOLS = (
    # Import-time facts already include overview, summary metrics, sprint
    # candidates and sustained-effort/climb candidates.  The child agent only
    # receives tools that inspect a user-requested raw FIT window in more detail.
    ToolDef(
        name="get_time_intervals",
        description="""Fixed time-window averages. bucket_seconds supports 1-600s. Use start_s/end_s for a focused window. Includes non-zero averages and zero fractions.
Use for: time-based averages (every 1min, 5min), inspecting a specific time window (e.g., 100-200s hard effort).
Prefer 30s/60s/5min for normal analysis. Use very small buckets like 3s only for focused short windows.""",
        input_schema={
            "type": "object",
            "properties": {
                "bucket_seconds": {"type": "integer", "default": 60},
                "start_s": {"type": ["integer", "null"], "default": None},
                "end_s": {"type": ["integer", "null"], "default": None},
            },
        },
        category=CATEGORY_FIT_QUERY,
    ),
    ToolDef(
        name="get_distance_intervals",
        description="""Fixed distance-window averages. Use bucket_distance_m for every 1km/3km/5km. Use start_d/end_d for a focused window. Includes non-zero averages and zero fractions.
Use for: distance-based averages (every 1km, 3km, 5km), inspecting a specific distance window (e.g., 2km-3km climb).
Prefer for climbs and pacing analysis.""",
        input_schema={
            "type": "object",
            "properties": {
                "bucket_distance_m": {"type": "integer", "default": 1000},
                "start_d": {"type": ["integer", "null"], "default": None},
                "end_d": {"type": ["integer", "null"], "default": None},
            },
        },
        category=CATEGORY_FIT_QUERY,
    ),
    ToolDef(
        name="get_running_efficiency",
        description="""Compare the first and last active 30% of a running activity. Returns pace, heart-rate, cadence and available running-dynamics changes, plus data-quality limits.
Use for: running-form stability, late-run pace change, or heart-rate response. Only use for running activities; it is descriptive and does not normalize terrain, weather, or stops.""",
        category=CATEGORY_FIT_QUERY,
    ),
    ToolDef(
        name="get_history",
        description="""Prior compact training history, if enabled for this analysis.
Use for: user explicitly asked to reference history, or longitudinal comparison materially improves the answer.
Do NOT request if the user hasn't asked for history context.""",
        category=CATEGORY_FIT_QUERY,
    ),
)


SUBMIT_ANALYSIS_TOOL = ToolDef(
    name="submit_analysis",
    description=(
        "Submit the final activity analysis and end the ActivityAnalysisAgent session. "
        "Call this exactly once after you have enough data. Do not call any data tools after it."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "markdown_report": {
                "type": "string",
                "minLength": 1,
                "description": (
                    "Complete but concise Chinese Markdown activity report, under 1800 Chinese characters, "
                    "that explicitly answers user_request when present. Never submit an empty string."
                ),
            },
            "strava_summary": {
                "type": "string",
                "minLength": 1,
                "description": "About 200 Chinese characters for Strava, following strava_summary_style.",
            },
            "analysis_summary": {
                "type": "object",
                "description": (
                    "Compact qualitative judgement for this report. Use load_label for a short non-numeric "
                    "description; objective TSS/IF/NP values are persisted by local code."
                ),
            },
        },
        "required": ["markdown_report", "strava_summary", "analysis_summary"],
    },
    category=CATEGORY_ANALYSIS,
)


SUBMIT_QUERY_ANSWER_TOOL = ToolDef(
    name="submit_query_answer",
    description=(
        "Submit a focused answer to one activity question and end the query session. "
        "This is not a full activity report and must not contain a Strava summary."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "answer": {
                "type": "string",
                "minLength": 1,
                "description": "Concise Chinese Markdown that directly answers the user's question.",
            },
            "evidence": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "value": {"type": "string"},
                        "source": {"type": "string"},
                    },
                    "required": ["label", "value"],
                },
                "description": "Small set of objective facts supporting the answer.",
            },
            "limitations": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Missing data or scope limits that materially affect the conclusion.",
            },
        },
        "required": ["answer", "evidence", "limitations"],
    },
    category=CATEGORY_ANALYSIS,
)


# The child agent receives both read-only FIT tools and the explicit completion
# tool. Keeping FIT_DATA_TOOLS separate preserves its read-only data contract.
FIT_ANALYSIS_TOOLS = (*FIT_DATA_TOOLS, SUBMIT_ANALYSIS_TOOL)
