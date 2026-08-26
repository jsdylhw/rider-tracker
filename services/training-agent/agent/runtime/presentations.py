"""Transport-neutral presentation blocks produced from deterministic tool results."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from domain.contracts.schemas import PRESENTATION_V1


@dataclass(frozen=True)
class PresentationBlock:
    """One structured UI block attached to a completed agent turn."""

    presentation_id: str
    type: str
    title: str
    data: dict[str, Any] = field(default_factory=dict)
    source: dict[str, Any] = field(default_factory=dict)
    schema_version: str = PRESENTATION_V1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
