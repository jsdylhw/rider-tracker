"""Tools exposed only to RouteNarrationAgent."""

from agent.tools.spec import CATEGORY_ANALYSIS, CATEGORY_FIT_QUERY, ToolDef

SEARCH_ROUTE_KNOWLEDGE = ToolDef(
    name="search_route_knowledge",
    description=(
        "Search factual places and regional route knowledge from representative "
        "route samples. The server applies a strict external-request budget, so "
        "use focused queries and do not search every display position."
    ),
    input_schema={
        "type": "object",
        "required": ["query", "sample_ids"],
        "properties": {
            "query": {"type": "string", "minLength": 2, "maxLength": 160},
            "sample_ids": {
                "type": "array", "minItems": 1, "maxItems": 8,
                "items": {"type": "string"},
            },
            "limit_per_sample": {"type": "integer", "minimum": 1, "maximum": 6, "default": 4},
        },
    },
    category=CATEGORY_FIT_QUERY,
)

READ_ROUTE_SOURCE = ToolDef(
    name="read_route_source",
    description="Read full normalized source records previously returned by search_route_knowledge.",
    input_schema={
        "type": "object",
        "required": ["source_ids"],
        "properties": {
            "source_ids": {
                "type": "array", "minItems": 1, "maxItems": 20,
                "items": {"type": "string"},
            }
        },
    },
    category=CATEGORY_FIT_QUERY,
)

SUBMIT_ROUTE_NARRATION_PLAN = ToolDef(
    name="submit_route_narration_plan",
    description="Submit the sourced narration cards and end RouteNarrationAgent.",
    input_schema={
        "type": "object",
        "required": ["items"],
        "properties": {
            "items": {
                "type": "array", "minItems": 1, "maxItems": 44,
                "items": {
                    "type": "object",
                    "required": ["sample_id", "content_scope", "source_ids", "title", "summary"],
                    "properties": {
                        "sample_id": {"type": "string"},
                        "content_scope": {
                            "type": "string", "enum": ["route", "place"],
                            "description": (
                                "route means regional/general content merely scheduled at this sample; "
                                "place means the subject is physically near this sample."
                            ),
                        },
                        "source_ids": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                        "category": {"type": "string"},
                        "title": {"type": "string", "maxLength": 80},
                        "summary": {"type": "string", "maxLength": 600},
                        "tts_text": {"type": "string", "maxLength": 300},
                        "priority": {"type": "number", "minimum": 0, "maximum": 10},
                    },
                },
            },
            "warnings": {"type": "array", "items": {"type": "string"}},
        },
    },
    category=CATEGORY_ANALYSIS,
)

ROUTE_NARRATION_TOOLS = (
    SEARCH_ROUTE_KNOWLEDGE,
    READ_ROUTE_SOURCE,
    SUBMIT_ROUTE_NARRATION_PLAN,
)
