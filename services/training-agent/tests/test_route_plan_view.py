from services.route.view import MAX_GEOMETRY_POINTS, build_route_plan_view


def test_route_plan_view_projects_candidates_segments_and_stable_ids():
    plan = {
        "plan_id": "route-1",
        "revision": 7,
        "title": "沿江路线",
        "country_code": "CN",
        "active_candidate_id": "candidate-1",
        "planning": {"status": "confirmed", "confirmed_candidate_id": "candidate-1"},
        "candidates": [{
            "candidate_id": "candidate-1",
            "name": "沿江候选",
            "distance_km": 31.5,
            "duration_min": 90,
            "provider": "amap",
            "travel_mode": "BICYCLE",
            "route_type": "loop",
            "geometry": {"type": "LineString", "coordinates": [[121.0, 31.0], [121.1, 31.1]]},
            "waypoints": [{"name": "起点", "longitude": 121.0, "latitude": 31.0}],
            "strava_segments": [{"segment_id": 42, "direction": "forward"}],
        }],
        "segment_pool": {"candidate-1": [{
            "segment_id": 42,
            "name": "江边路段",
            "distance_km": 4.2,
            "average_grade_percent": 1.5,
            "geometry": {"type": "LineString", "coordinates": [[121.02, 31.01], [121.05, 31.03]]},
        }]},
    }

    view = build_route_plan_view(plan)

    assert view["schema_version"] == "route_plan_view.v1"
    assert view["revision"] == 7
    assert view["confirmed_candidate_id"] == "candidate-1"
    candidate = view["candidates"][0]
    assert candidate["distance_m"] == 31_500
    assert candidate["provider_duration_s"] == 5_400
    assert candidate["is_closed"] is True
    assert candidate["segment_sequence"] == [{
        "segment_id": 42, "order": 1, "direction": "forward", "role": "included",
    }]
    assert view["segments"][0]["candidate_ids"] == ["candidate-1"]
    assert view["segments"][0]["geometry"]["coordinates"][-1] == [121.05, 31.03]


def test_route_plan_view_deduplicates_segment_catalog_and_bounds_geometry():
    coordinates = [[120 + index / 100_000, 30] for index in range(MAX_GEOMETRY_POINTS + 25)]
    segment = {"segment_id": "9", "name": "公共路段"}
    view = build_route_plan_view({
        "plan_id": "route-2",
        "candidates": [{
            "candidate_id": "candidate-1",
            "geometry": {"coordinates": coordinates + [[999, 999], [float("inf"), 30]]},
        }],
        "segment_pool": {"candidate-1": [segment], "candidate-2": [segment]},
    })

    assert len(view["candidates"][0]["geometry"]["coordinates"]) == MAX_GEOMETRY_POINTS
    assert view["segments"] == [{
        "segment_id": 9,
        "name": "公共路段",
        "sport_type": "Ride",
        "distance_m": None,
        "average_grade_percent": None,
        "maximum_grade_percent": None,
        "elevation_difference_m": None,
        "distance_to_route_m": None,
        "route_overlap_ratio": None,
        "candidate_ids": ["candidate-1", "candidate-2"],
        "geometry": None,
    }]


def test_route_plan_view_projects_itinerary_stages():
    view = build_route_plan_view({
        "plan_id": "route-3",
        "schedule_type": "multi_day",
        "candidates": [{
            "candidate_id": "candidate-1",
            "stages": [{
                "stage_id": "day-1",
                "label": "第一天",
                "distance_m": 100_000,
                "geometry": {"coordinates": [[119, 29], [119.5, 29.5]]},
            }],
        }],
        "segment_pool": {"day-1": [{"segment_id": 18, "name": "第一天路段"}]},
    })

    assert view["candidates"][0]["stages"][0]["stage_id"] == "day-1"
    assert view["candidates"][0]["stages"][0]["distance_m"] == 100_000
    assert view["segments"][0]["candidate_ids"] == ["candidate-1"]
