from __future__ import annotations

from agent.narration.agent import _NarrationWorkspace, run_route_narration_agent
from services.narration.density import narration_density, narration_research_policy


class FakePlaces:
    def search_near_route_point(self, **kwargs):
        return [{
            "source_id": "google_place:1",
            "name": "屋岛",
            "address": "香川县高松市",
            "primary_type": "景胜地",
            "summary": "濑户内海沿岸的历史景胜地。",
            "latitude": kwargs["latitude"],
            "longitude": kwargs["longitude"],
            "url": "https://example.test/place/1",
        }]


class FakeLlm:
    def __init__(self):
        self.step = 0

    def create_messages(self, **_kwargs):
        self.step += 1
        if self.step == 1:
            return _tool("search_route_knowledge", "search-1", {
                "query": "屋岛 历史 景观",
                "sample_ids": ["sample_1"],
            })
        if self.step == 2:
            return _tool("read_route_source", "read-1", {
                "source_ids": ["google_place:1"],
            })
        return _tool("submit_route_narration_plan", "submit-1", {
            "items": [{
                "sample_id": "sample_2",
                "content_scope": "route",
                "source_ids": ["google_place:1"],
                "category": "history",
                "title": "屋岛",
                "summary": "屋岛位于高松一带，是可以俯瞰濑户内海的历史景胜地。",
                "tts_text": "前方是屋岛，这里以濑户内海景观和历史遗迹闻名。",
            }]
        })


class RepairingFakeLlm(FakeLlm):
    def create_messages(self, **kwargs):
        self.step += 1
        if self.step == 1:
            return _tool("search_route_knowledge", "search-1", {
                "query": "屋岛 历史 景观",
                "sample_ids": ["sample_1"],
            })
        if self.step == 2:
            return _tool("read_route_source", "read-1", {"source_ids": ["google_place:1"]})
        if self.step == 3:
            return _tool("submit_route_narration_plan", "bad-submit", {
                "items": [{
                    "sample_id": "sample_2", "content_scope": "place",
                    "source_ids": ["google_place:1"], "title": "错误绑定", "summary": "错误。",
                }],
            })
        assert kwargs["messages"][-1]["content"][0]["is_error"] is True
        return _tool("submit_route_narration_plan", "fixed-submit", {
            "items": [{
                "sample_id": "sample_2", "content_scope": "route",
                "source_ids": ["google_place:1"], "title": "区域历史", "summary": "修正后内容。",
            }],
        })


def _tool(name, tool_id, arguments):
    return {
        "content": [{"type": "tool_use", "id": tool_id, "name": name, "input": arguments}],
        "stop_reason": "tool_use",
        "model": "fake",
    }


def _request():
    return {
        "route_fingerprint": "route_1234abcd",
        "route_name": "高松测试路线",
        "total_distance_m": 30000,
        "estimated_duration_min": 120,
        "locale": "zh-CN",
        "samples": [
            {"sample_id": "sample_1", "route_distance_m": 0, "latitude": 34.3, "longitude": 134.1},
            {"sample_id": "sample_2", "route_distance_m": 30000, "latitude": 34.4, "longitude": 134.2},
        ],
    }


def test_two_hour_density_targets_twenty_four_cards():
    assert narration_density(120) == {"minimum": 20, "target": 24, "maximum": 32}
    assert narration_research_policy(120) == {
        "place_card_maximum": 8,
        "search_request_maximum": 18,
        "samples_per_search": 3,
        "search_concurrency": 4,
    }


def test_route_narration_agent_searches_reads_and_submits_sourced_cards():
    plan = run_route_narration_agent(_request(), places_client=FakePlaces(), client=FakeLlm())

    assert plan["schema_version"] == "route_narration_plan.v1"
    assert plan["route_fingerprint"] == "route_1234abcd"
    assert plan["status"] == "partial"
    assert plan["items"][0]["title"] == "屋岛"
    assert plan["items"][0]["content_scope"] == "route"
    assert plan["items"][0]["route_distance_m"] == 30000
    assert plan["items"][0]["sources"][0]["source_id"] == "google_place:1"


def test_route_narration_agent_repairs_an_invalid_submission_without_researching_again():
    places = FakePlaces()
    llm = RepairingFakeLlm()

    plan = run_route_narration_agent(_request(), places_client=places, client=llm)

    assert llm.step == 4
    assert plan["items"][0]["content_scope"] == "route"
    assert plan["items"][0]["title"] == "区域历史"


class CountingPlaces:
    def __init__(self):
        self.calls = []

    def search_near_route_point(self, **kwargs):
        self.calls.append(kwargs)
        return [{
            "source_id": f"google_place:{kwargs['latitude']}:{kwargs['longitude']}",
            "name": "资料点",
            "summary": "区域资料",
        }]


def test_narration_search_uses_representative_samples_and_hard_provider_budget():
    request = _request()
    request["samples"] = [
        {
            "sample_id": f"sample_{index}",
            "route_distance_m": index * 1000,
            "latitude": 34 + index / 100,
            "longitude": 134 + index / 100,
        }
        for index in range(1, 7)
    ]
    places = CountingPlaces()
    workspace = _NarrationWorkspace(request, places, research_policy={
        "place_card_maximum": 2,
        "search_request_maximum": 2,
        "samples_per_search": 3,
        "search_concurrency": 2,
    })

    first = workspace.search({
        "query": "区域历史",
        "sample_ids": [f"sample_{index}" for index in range(1, 7)],
    })
    second = workspace.search({
        "query": "地方文化",
        "sample_ids": [f"sample_{index}" for index in range(1, 7)],
    })

    assert len(places.calls) == 2
    assert first["research_budget"] == {"used": 2, "maximum": 2, "remaining": 0}
    assert second["results"] == []
    assert second["research_budget"]["remaining"] == 0


def test_place_cards_require_local_source_and_obey_limit_but_route_cards_can_reuse_source():
    request = _request()
    places = CountingPlaces()
    workspace = _NarrationWorkspace(request, places, research_policy={
        "place_card_maximum": 1,
        "search_request_maximum": 4,
        "samples_per_search": 2,
        "search_concurrency": 2,
    })
    searched = workspace.search({"query": "历史", "sample_ids": ["sample_1", "sample_2"]})
    source_ids = [result["source_id"] for result in searched["results"]]
    workspace.read({"source_ids": source_ids})

    plan = workspace.build_plan({"items": [
        {
            "sample_id": "sample_1", "content_scope": "place", "source_ids": [source_ids[0]],
            "title": "起点地点", "summary": "与起点直接相关。",
        },
        {
            "sample_id": "sample_2", "content_scope": "place", "source_ids": [source_ids[1]],
            "title": "超额地点卡片", "summary": "来源与终点直接相关但超过点位卡片上限。",
        },
        {
            "sample_id": "sample_2", "content_scope": "route", "source_ids": [source_ids[0]],
            "title": "区域历史", "summary": "在路线后段播放的区域介绍。",
        },
    ]}, density={"minimum": 2, "target": 2, "maximum": 4})

    assert [(item["content_scope"], item["title"]) for item in plan["items"]] == [
        ("place", "起点地点"),
        ("route", "区域历史"),
    ]
