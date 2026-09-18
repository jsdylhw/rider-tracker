"""Shared acceptance bound for an explicit target and actual routed distance."""
from __future__ import annotations

MIN_TARGET_DISTANCE_RATIO = 0.60
MAX_TARGET_DISTANCE_RATIO = 1.50


def target_distance_error(distance_m: float, target_distance_km: float | None) -> str | None:
    if target_distance_km is None:
        return None
    target = float(target_distance_km)
    minimum = target * MIN_TARGET_DISTANCE_RATIO
    maximum = target * MAX_TARGET_DISTANCE_RATIO
    actual = float(distance_m) / 1000.0
    if minimum <= actual <= maximum:
        return None
    return (
        f"距离偏离目标：实际 {actual:.1f} km，目标 {target:.1f} km，"
        f"允许范围 {minimum:.1f}-{maximum:.1f} km；该候选未满足距离要求"
    )
