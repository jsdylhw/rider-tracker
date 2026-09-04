"""Provider-independent geographic calculations for route services."""

from __future__ import annotations

import math
from collections.abc import Sequence


EARTH_RADIUS_M = 6_371_000.0


def haversine_m(first: Sequence[float], second: Sequence[float]) -> float:
    """Return great-circle distance for two ``(longitude, latitude)`` points."""
    lon1, lat1 = map(math.radians, (float(first[0]), float(first[1])))
    lon2, lat2 = map(math.radians, (float(second[0]), float(second[1])))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.asin(math.sqrt(value))
