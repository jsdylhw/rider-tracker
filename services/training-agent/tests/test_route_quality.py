from __future__ import annotations

import pytest

from services.route.quality import (
    apply_route_constraints,
    evaluate_navigation,
    evaluate_self_overlap,
    normalize_route_constraints,
    normalize_route_preferences,
    preference_score,
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


def test_amap_navigation_evidence_counts_turns_and_special_passages():
    quality = evaluate_navigation([
        {"action": "左转", "road_name": "新塘路", "walk_type": "0"},
        {"action": "向右前方行驶", "road_name": "", "walk_type": "23"},
        {"action": "掉头", "road_name": "环站东路", "walk_type": "30"},
    ], distance_m=6_000)

    assert quality["navigation_data_source"] == "amap_navigation"
    assert quality["left_turn_count"] == 1
    assert quality["right_turn_count"] == 1
    assert quality["u_turn_count"] == 1
    assert quality["steps_per_km"] == 0.5
    assert quality["passage_counts"]["tunnel"] == 1
    assert quality["passage_counts"]["ferry"] == 1


@pytest.mark.parametrize(
    ("constraints", "message"),
    [
        ({"avoid_u_turns": True}, "掉头"),
        ({"avoid_ferry": True}, "轮渡"),
        ({"maximum_detour_ratio": 0.1}, "多绕行"),
    ],
)
def test_navigation_and_detour_hard_constraints_reject_provider_alternative(constraints, message):
    with pytest.raises(RouteCandidateRejected, match=message):
        apply_route_constraints(
            {
                "distance_m": 12_000,
                "baseline_distance_m": 10_000,
                "geometry": {"type": "LineString", "coordinates": [_point(0, 0), _point(12_000, 0)]},
                "navigation_steps": [{"action": "掉头", "walk_type": "30"}],
            },
            constraints,
            rejection_type=RouteCandidateRejected,
        )


def test_route_preference_score_uses_turn_bias_without_making_it_a_constraint():
    preferences = normalize_route_preferences({"turn_bias": "fewer_left"})
    fewer_left = apply_route_constraints({
        "distance_m": 10_000,
        "duration_s": 2_000,
        "baseline_distance_m": 10_000,
        "baseline_duration_s": 2_000,
        "geometry": {"type": "LineString", "coordinates": [_point(0, 0), _point(10_000, 0)]},
        "navigation_steps": [{"action": "右转", "road_name": "A"}],
    }, None)
    more_left = apply_route_constraints({
        **fewer_left,
        "navigation_steps": [
            {"action": "左转", "road_name": "A"},
            {"action": "左转", "road_name": "B"},
        ],
    }, None)

    assert preference_score(fewer_left, preferences) < preference_score(more_left, preferences)


def test_provider_specific_hard_constraint_requires_provider_evidence():
    with pytest.raises(RouteCandidateRejected, match="没有高德导航步骤"):
        apply_route_constraints(
            {
                "distance_m": 10_000,
                "geometry": {"type": "LineString", "coordinates": [_point(0, 0), _point(10_000, 0)]},
            },
            {"avoid_ferry": True},
            rejection_type=RouteCandidateRejected,
        )
