"""Semantic search checks; no model, provider, or database calls."""
from copy import deepcopy

from services.route.skeleton_search import rank_skeletons


def fixture():
    coordinates = {
        "a": [135, 35], "b": [135.015, 35.02], "c": [135.06, 35.04],
        "d": [135.09, 35.08], "e": [135.04, 35.12], "f": [134.95, 35.04],
    }
    materials = {
        "origin_id": "a", "is_loop": True, "target_distance_km": 30,
        "points": [{"id": key, "required": key == "a"} for key in coordinates],
        "corridors": [],
    }
    return materials, {key: {"coordinate": coordinate} for key, coordinate in coordinates.items()}


def test_pool_retains_shorter_lengths_and_removes_reverse_duplicates():
    materials, points = fixture()
    result = rank_skeletons(materials, points)
    assert len(result) > 3
    assert min(route["estimated_distance_m"] for route in result) < 24000
    assert max(route["estimated_distance_m"] for route in result) > 30000
    signatures = [min(tuple(route["point_ids"]), tuple(reversed(route["point_ids"]))) for route in result]
    assert len(signatures) == len(set(signatures))


def test_required_points_do_not_imply_array_order_but_explicit_order_does():
    materials, points = fixture()
    # Fix direction with b -> c and require f too: f can precede b or follow c.
    materials["points"][-1]["required"] = True
    materials["corridors"] = [{"id": "river", "point_ids": ["b", "c"], "required": True}]
    result = rank_skeletons(materials, points, limit=100)
    assert any(route["point_ids"].index("f") < route["point_ids"].index("b") for route in result)
    assert any(route["point_ids"].index("f") > route["point_ids"].index("c") for route in result)
    materials["ordered_point_ids"] = ["b", "c", "f"]
    result = rank_skeletons(materials, points)
    assert result
    assert all(route["point_ids"].index("b") < route["point_ids"].index("c") < route["point_ids"].index("f") for route in result)


def test_required_corridor_is_contiguous_and_directed():
    materials, points = fixture()
    materials["corridors"] = [{"id": "river", "point_ids": ["b", "c", "d"], "required": True}]
    result = rank_skeletons(materials, points)
    assert result
    for route in result:
        ids = route["point_ids"]
        start = ids.index("b")
        assert ids[start:start + 3] == ["b", "c", "d"]
        assert route["control_corridor_coverage"]["river"] == 1


def test_optional_corridor_has_partial_contiguous_coverage_and_preference():
    materials, points = fixture()
    materials["corridors"] = [{"id": "river", "point_ids": ["b", "c", "d", "e"], "required": False, "weight": 2}]
    result = rank_skeletons(materials, points, limit=50)
    assert any(0 < route["control_corridor_coverage"]["river"] < 1 for route in result)
    for route in result:
        assert abs(route["preferred_score"] - 2 * route["control_corridor_coverage"]["river"]) < .0001
        assert ("river" in route["corridor_ids"]) == (route["control_corridor_coverage"]["river"] == 1)


def test_whole_optional_corridor_never_rewards_fragments():
    materials, points = fixture()
    materials["corridors"] = [{"id": "river", "point_ids": ["b", "c", "d", "e"],
                               "required": False, "allow_partial": False, "preference_weight": 3}]
    result = rank_skeletons(materials, points, limit=100)
    assert any(route["control_corridor_coverage"]["river"] == 1 for route in result)
    assert any(0 < route["control_corridor_coverage"]["river"] < 1 for route in result)
    for route in result:
        coverage = route["control_corridor_coverage"]["river"]
        assert route["preferred_score"] == (3 if coverage == 1 else 0)
        if coverage == 1:
            start = route["point_ids"].index("b")
            assert route["point_ids"][start:start + 4] == ["b", "c", "d", "e"]


def test_required_corridor_preserves_full_block_even_when_partial_is_allowed():
    materials, points = fixture()
    materials["points"][-1]["required"] = True
    materials["corridors"] = [{"id": "river", "point_ids": ["b", "c", "d", "e"],
                               "required": True, "allow_partial": True}]
    result = rank_skeletons(materials, points, limit=100)
    assert result
    for route in result:
        ids = route["point_ids"]
        start = ids.index("b")
        assert ids[start:start + 4] == ["b", "c", "d", "e"]
        assert ids.index("f") < start or ids.index("f") >= start + 4


def test_estimate_target_and_selected_route_seed_do_not_mutate_inputs():
    materials, points = fixture()
    before = deepcopy((materials, points))
    seed = ["a", "b", "c", "a"]
    result = rank_skeletons(materials, points, estimated_target_m=18000, seed_point_ids=seed)
    assert result
    assert before == (materials, points)
    assert all(abs(route["score"] - abs(route["estimated_distance_m"] - 18000)) < .1 for route in result)
    # Strava is evidence only until actual mixed-path validation is implemented.
    assert result == rank_skeletons(materials, points, [{"segment_id": 3}], estimated_target_m=18000, seed_point_ids=seed)
    assert all(leg["kind"] == "connector" for route in result for leg in route["legs"])


def test_open_route_keeps_endpoints_and_required_points():
    materials, points = fixture()
    materials.update(is_loop=False, destination_id="f")
    materials["points"][2]["required"] = True
    result = rank_skeletons(materials, points)
    assert result
    assert all(route["point_ids"][0] == "a" and route["point_ids"][-1] == "f" and "c" in route["point_ids"] for route in result)
