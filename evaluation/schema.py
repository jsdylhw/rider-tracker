"""Versioned JSONL schema for agent evaluation cases."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class EvalCaseError(ValueError):
    """An evaluation case is malformed."""


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    input: str
    mode: str = "skill"
    tags: tuple[str, ...] = ()
    expected: dict[str, Any] = field(default_factory=dict)
    tool_outputs: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, payload: dict[str, Any], *, source: str = "") -> "EvalCase":
        if not isinstance(payload, dict):
            raise EvalCaseError(f"case must be an object: {source}")
        case_id = str(payload.get("case_id") or payload.get("id") or "").strip()
        user_input = str(payload.get("input") or "").strip()
        mode = str(payload.get("mode") or "skill").strip().lower()
        if not case_id or not user_input:
            raise EvalCaseError(f"case_id and input are required: {source}")
        if mode not in {"skill", "live"}:
            raise EvalCaseError(f"unsupported mode {mode!r}: {source}")
        expected = payload.get("expected") or {}
        tool_outputs = payload.get("tool_outputs") or {}
        if not isinstance(expected, dict) or not isinstance(tool_outputs, dict):
            raise EvalCaseError(f"expected and tool_outputs must be objects: {source}")
        return cls(
            case_id=case_id,
            input=user_input,
            mode=mode,
            tags=tuple(str(tag) for tag in payload.get("tags") or []),
            expected=expected,
            tool_outputs=tool_outputs,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "agent_eval_case.v1",
            "case_id": self.case_id,
            "input": self.input,
            "mode": self.mode,
            "tags": list(self.tags),
            "expected": self.expected,
            "tool_outputs": self.tool_outputs,
        }


def load_cases(path: str | Path) -> list[EvalCase]:
    source = Path(path)
    cases: list[EvalCase] = []
    seen: set[str] = set()
    for line_number, raw in enumerate(source.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise EvalCaseError(f"invalid JSON at {source}:{line_number}: {exc}") from exc
        case = EvalCase.from_dict(payload, source=f"{source}:{line_number}")
        if case.case_id in seen:
            raise EvalCaseError(f"duplicate case_id {case.case_id!r} in {source}")
        seen.add(case.case_id)
        cases.append(case)
    if not cases:
        raise EvalCaseError(f"no evaluation cases found in {source}")
    return cases
