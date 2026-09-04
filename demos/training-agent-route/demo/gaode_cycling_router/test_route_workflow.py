from __future__ import annotations

from demo.gaode_cycling_router.route_evidence import Bounds
from demo.gaode_cycling_router.route_workflow import LandmarkRouteRequest, rank_skeleton_orders, run_landmark_evidence_workflow, select_detail_candidates
from demo.osm_cycling_router.router import Point
from demo.osm_cycling_router.segment_loop import DirectedSegment


def _encoded_detail(segment_id: int, points: list[list[float]]) -> dict:
    # The workflow uses production Segment normalisation; encode only the
    # simple polylines needed by the test instead of bypassing that boundary.
    def encode(values: list[list[float]]) -> str:
        previous = [0, 0]
        output: list[str] = []
        for lon, lat in values:
            for index, value in enumerate((int(round(lat * 100_000)), int(round(lon * 100_000)))):
                delta = value - previous[index]
                previous[index] = value
                shifted = ~(delta << 1) if delta < 0 else delta << 1
                while shifted >= 0x20:
                    output.append(chr((0x20 | (shifted & 0x1F)) + 63))
                    shifted >>= 5
                output.append(chr(shifted + 63))
        return "".join(output)
    return {"id": segment_id, "name": f"segment {segment_id}", "distance": 1_000, "map": {"polyline": encode(points)}}


def test_selection_prefers_endpoint_side_coverage_before_popularity() -> None:
    target = Bounds(0, 0, 1, 1)
    selected = select_detail_candidates([
        {"id": 1, "distance": 10_000, "start_latlng": [.5, .5], "end_latlng": [.6, .6]},
        {"id": 2, "distance": 1_000, "start_latlng": [.99, .5], "end_latlng": [.5, .99]},
        {"id": 3, "distance": 1_000, "start_latlng": [.01, .5], "end_latlng": [.5, .01]},
    ], target, maximum=2)
    assert [item["id"] for item in selected] == [2, 3]


def test_selection_uses_landmark_alias_only_as_a_tie_breaker_after_side_coverage() -> None:
    target = Bounds(0, 0, 1, 1)
    selected = select_detail_candidates([
        {"id": 1, "name": "Dianshan Lake road", "distance": 1_000, "start_latlng": [.99, .5], "end_latlng": [.5, .99]},
        {"id": 2, "name": "unrelated road", "distance": 9_000, "start_latlng": [.99, .5], "end_latlng": [.5, .99]},
        {"id": 3, "name": "Dianshan south", "distance": 1_000, "start_latlng": [.01, .5], "end_latlng": [.5, .01]},
    ], target, maximum=2, semantic_terms=["dianshan"])
    assert [item["id"] for item in selected] == [1, 3]


def test_workflow_is_bounded_and_refuses_incomplete_landmark_loop() -> None:
    calls: list[str] = []
    details: list[int] = []

    def explore(bounds: str, _: str) -> dict:
        calls.append(bounds)
        return {"segments": [{"id": 7, "distance": 5_000, "start_latlng": [1, 0], "end_latlng": [0, 0]}]}

    def fetch(segment_id: int, _: str) -> dict:
        details.append(segment_id)
        return _encoded_detail(segment_id, [[0, 0], [0, 1]])

    result = run_landmark_evidence_workflow(
        LandmarkRouteRequest("示例湖", Bounds(0, 0, 1, 1), 60_000, 80_000), "token",
        explorer=explore, detail_fetcher=fetch,
    )
    assert len(calls) == 4
    assert details == [7]
    assert result["status"] == "needs_more_evidence"
    assert result["loop_evidence"]["status"] == "insufficient_perimeter_evidence"
    assert result["selected_segment_ids"] == [7]


def test_workflow_reuses_cached_detail_geometry_without_another_network_call() -> None:
    cached = {
        "type": "Feature", "properties": {"id": 7, "kind": "strava_segment"},
        "geometry": {"type": "LineString", "coordinates": [[0, 0], [0, 1]]},
    }

    def explore(_: str, __: str) -> dict:
        return {"segments": [{"id": 7, "distance": 5_000}]}

    def must_not_fetch(_: int, __: str) -> dict:
        raise AssertionError("cached geometry should be used")

    result = run_landmark_evidence_workflow(
        LandmarkRouteRequest("示例湖", Bounds(0, 0, 1, 1), 60_000, 80_000), "token",
        explorer=explore, detail_fetcher=must_not_fetch, cached_features=[cached],
    )
    assert result["cached_detail_segment_ids"] == [7]


def test_order_ranking_can_emit_reverse_direction_variants_for_provider_validation() -> None:
    segments = [
        DirectedSegment(1, "向东", ((1, 0), (2, 0)), 1_000, 0, {}),
        DirectedSegment(2, "向西", ((4, 0), (3, 0)), 1_000, 0, {}),
    ]
    ranked = rank_skeleton_orders(segments, start=Point(0, 0), target_distance_m=900_000, max_candidates=8)
    assert len(ranked) == 8
    assert any(
        segment.properties.get("route_direction") == "reverse"
        for candidate in ranked for segment in candidate.segments
    )
