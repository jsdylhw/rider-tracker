from __future__ import annotations

import pytest

from services.route.quality import (
    apply_route_constraints,
    evaluate_self_overlap,
    normalize_route_constraints,
)
from services.route.single_day import RouteCandidateRejected


def _point(x_meters: float, y_meters: float) -> list[float]:
    return [x_meters / 111_320.0, y_meters / 110_540.0]


def test_out_and_back_exceeds_default_self_overlap_limit():
    quality = evaluate_self_overlap([
        _point(0, 0),
        _point(1_000, 0),
        _point(0, 0),
    ])

    assert quality["self_overlap_ratio"] > 0.40
    with pytest.raises(RouteCandidateRejected, match="路线自身重复率"):
        apply_route_constraints(
            {"geometry": {"type": "LineString", "coordinates": [
                _point(0, 0), _point(1_000, 0), _point(0, 0),
            ]}},
            {"avoid_repeated_roads": True, "maximum_self_overlap_ratio": 0.1},
            rejection_type=RouteCandidateRejected,
        )


def test_closed_loop_and_perpendicular_crossing_are_not_repeated_roads():
    loop = evaluate_self_overlap([
        _point(0, 0), _point(1_000, 0), _point(1_000, 1_000),
        _point(0, 1_000), _point(0, 0),
    ])
    crossing = evaluate_self_overlap([
        _point(-500, -500), _point(500, 500),
        _point(-500, 500), _point(500, -500),
    ])

    assert loop["self_overlap_ratio"] == 0.0
    assert crossing["self_overlap_ratio"] == 0.0


def test_short_shared_start_and_finish_access_remains_below_limit():
    quality = evaluate_self_overlap([
        _point(0, 0), _point(200, 0), _point(1_000, 0),
        _point(1_000, 1_000), _point(200, 1_000),
        _point(200, 0), _point(0, 0),
    ])

    assert quality["self_overlap_ratio"] < 0.10


@pytest.mark.parametrize("value", [-0.01, 1.01, "invalid"])
def test_route_constraint_ratio_rejects_invalid_values(value):
    with pytest.raises(ValueError, match="maximum_self_overlap_ratio"):
        normalize_route_constraints({"maximum_self_overlap_ratio": value})


def test_disabled_constraint_still_exposes_quality_evidence():
    candidate = apply_route_constraints(
        {"geometry": {"type": "LineString", "coordinates": [
            _point(0, 0), _point(1_000, 0), _point(0, 0),
        ]}},
        None,
        rejection_type=RouteCandidateRejected,
    )

    assert candidate["route_quality"]["self_overlap_ratio"] > 0.40
