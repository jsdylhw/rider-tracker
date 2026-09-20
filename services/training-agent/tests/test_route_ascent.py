from copy import deepcopy

from services.route import single_day
from services.route.ascent import enrich_ascent_preview
from services.route.view import build_route_plan_view


def test_google_ascent_is_reference_only_and_missing_elevation_is_optional(monkeypatch):
    plan = {"plan_id": "p", "candidates": [{"candidate_id": "a", "distance_m": 30000,
            "geometry": {"coordinates": [[135,35], [135.1,35.1]]}}]}
    before = deepcopy(plan)
    monkeypatch.setattr(single_day, "_read_json_url", lambda *a, **kw: {
        "status": "OK", "results": [{"elevation": height} for height in [20, 70, 120, 70, 20]]})
    result = enrich_ascent_preview(plan, config={"google": {"api_key": "test"}})
    preview = build_route_plan_view(result)["candidates"][0]["ascent_preview"]
    assert preview["ascent_m"] > 0
    assert preview["simulation_usable"] is False
    assert "elevation" not in result["candidates"][0]
    assert result["candidates"][0]["geometry"] == before["candidates"][0]["geometry"]
    profile = single_day._elevation_profile([[135,35], [135.1,35.1]], 30000, {"google": {"api_key": "test"}})
    assert not any("grade" in key or "percent" in key for key in profile["summary"])
    assert plan == before
    calls = []
    original = single_day._elevation_profile
    monkeypatch.setattr(single_day, "_elevation_profile", lambda *a, **kw: (calls.append(a), original(*a, **kw))[1])
    enrich_ascent_preview(result, config={"google": {"api_key": "test"}})
    assert calls == []  # Switching preview does not repeat paid elevation requests.
    result["candidates"][0]["geometry"]["coordinates"].reverse()
    enrich_ascent_preview(result, config={"google": {"api_key": "test"}})
    assert len(calls) == 1
    unavailable = enrich_ascent_preview(plan, config={})
    assert len(unavailable["candidates"]) == 1
    assert "ascent_preview" not in unavailable["candidates"][0]
    assert "不影响路线" in unavailable["candidates"][0]["warnings"][0]
