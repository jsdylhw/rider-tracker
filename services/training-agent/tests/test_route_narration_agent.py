from __future__ import annotations

from agent.narration.agent import run_route_narration_agent
from services.narration.density import narration_density


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
                "sample_id": "sample_1",
                "source_ids": ["google_place:1"],
                "category": "history",
                "title": "屋岛",
                "summary": "屋岛位于高松一带，是可以俯瞰濑户内海的历史景胜地。",
                "tts_text": "前方是屋岛，这里以濑户内海景观和历史遗迹闻名。",
            }]
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


def test_route_narration_agent_searches_reads_and_submits_sourced_cards():
    plan = run_route_narration_agent(_request(), places_client=FakePlaces(), client=FakeLlm())

    assert plan["schema_version"] == "route_narration_plan.v1"
    assert plan["route_fingerprint"] == "route_1234abcd"
    assert plan["status"] == "partial"
    assert plan["items"][0]["title"] == "屋岛"
    assert plan["items"][0]["sources"][0]["source_id"] == "google_place:1"
