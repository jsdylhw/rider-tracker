"""Application-owned FIT loading with the canonical athlete profile injected."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fit.parser import parse_fit
from services.athlete.profile import get_athlete_profile


def parse_activity_fit(path: str | Path) -> dict[str, Any]:
    return parse_fit(path, athlete_profile=get_athlete_profile())
