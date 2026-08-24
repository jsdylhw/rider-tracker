"""Bounded contracts between LLM semantics and deterministic analysis code."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


OBJECTIVES = {
    "inspect_activity",
    "evaluate_performance",
    "explain_power_drop",
    "analyze_hr_drift",
    "analyze_pacing",
    "detect_intervals",
    "compare_segments",
    "compare_activities",
    "summarize_training",
    "answer_question",
}
DEPTHS = {"inspect", "deep", "full"}


@dataclass(frozen=True)
class AnalysisRequest:
    """LLM-produced intent after activity and segment resolution."""

    objective: str = "inspect_activity"
    depth: str = "inspect"
    question: str | None = None
    metric_scope: tuple[str, ...] = ()

    @classmethod
    def from_arguments(cls, arguments: dict[str, Any]) -> "AnalysisRequest":
        objective = str(arguments.get("objective") or "inspect_activity")
        depth = str(arguments.get("depth") or "inspect")
        if objective not in OBJECTIVES:
            raise ValueError(f"unsupported analysis objective: {objective}")
        if depth not in DEPTHS:
            raise ValueError(f"unsupported analysis depth: {depth}")
        question = str(arguments.get("question") or "").strip() or None
        if objective == "answer_question" and not question:
            raise ValueError("answer_question requires question")
        raw_metrics = arguments.get("metric_scope")
        metrics = tuple(str(value) for value in raw_metrics) if isinstance(raw_metrics, list) else ()
        return cls(objective=objective, depth=depth, question=question, metric_scope=metrics)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["metric_scope"] = list(self.metric_scope)
        return value


@dataclass(frozen=True)
class SegmentRef:
    """Concrete, detector-backed window inside one immutable FIT activity."""

    segment_id: str
    activity_id: str
    segment_type: str
    ordinal: int
    start_seconds: float
    end_seconds: float
    metrics: dict[str, Any] = field(default_factory=dict)
    detector: str = "activity_scan.v1"
    confidence: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ResolvedTarget:
    """Execution target containing only frozen database and segment identities."""

    activity_ids: tuple[str, ...]
    segments: tuple[SegmentRef, ...] = ()
    objective: str = "inspect_activity"
    depth: str = "inspect"
    question: str | None = None
    metric_scope: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "resolved_analysis_target.v1",
            "activity_ids": list(self.activity_ids),
            "segments": [segment.to_dict() for segment in self.segments],
            "objective": self.objective,
            "depth": self.depth,
            "question": self.question,
            "metric_scope": list(self.metric_scope),
        }
