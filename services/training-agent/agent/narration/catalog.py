"""Structured output contract for the one-shot narration composer."""

from agent.tools.spec import CATEGORY_ANALYSIS, ToolDef

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
                    "required": ["sample_id", "content_scope", "title", "summary"],
                    "properties": {
                        "sample_id": {"type": "string"},
                        "content_scope": {
                            "type": "string", "enum": ["route", "place"],
                            "description": (
                                "route means regional/general content merely scheduled at this sample; "
                                "place means the subject is physically near this sample."
                            ),
                        },
                        "source_ids": {"type": "array", "items": {"type": "string"}},
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
    SUBMIT_ROUTE_NARRATION_PLAN,
)
