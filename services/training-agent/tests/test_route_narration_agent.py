from __future__ import annotations

import json

from agent.narration.agent import _NarrationWorkspace, run_route_narration_agent
from integrations.google_places import GooglePlacesClient, _normalize_place
from services.narration.density import narration_density, narration_research_policy


class CountingPlaces:
    def __init__(self, *, fail_latitude: float | None = None):
        self.calls = []
        self.fail_latitude = fail_latitude

    def search_near_route_point(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["latitude"] == self.fail_latitude:
            raise RuntimeError("provider unavailable")
        return [{
            "source_id": f"google_place:{kwargs['latitude']}:{kwargs['longitude']}",
            "name": "资料点",
            "address": "测试地址",
            "primary_type": "景胜地",
            "summary": "区域资料",
            "latitude": kwargs["latitude"],
            "longitude": kwargs["longitude"],
            "url": "https://maps.google.test/place",
            "photos": [{
                "photo_name": "places/place_1/photos/photo_1",
                "width": 1200,
                "height": 800,
                "author_attributions": [{
                    "display_name": "测试摄影者",
                    "uri": "https://maps.google.test/author",
                    "photo_uri": "https://images.google.test/author.jpg",
                }],
            }],
        }]


class OneShotLlm:
    def __init__(self):
        self.calls = []

    def create_messages(self, **kwargs):
        self.calls.append(kwargs)
        payload = json.loads(kwargs["messages"][0]["content"])
        source_id = payload["representative_places"][0]["places"][0]["source_id"]
        return _tool("submit_route_narration_plan", "submit-1", {
            "items": [
                {
                    "sample_id": "sample_1",
                    "content_scope": "place",
                    "source_ids": [source_id],
                    "category": "landscape",
                    "title": "沿途景观",
                    "summary": "这是与路线起点直接关联的景观资料。",
                },
                {
                    "sample_id": "sample_2",
                    "content_scope": "route",
                    "category": "history",
                    "title": "区域历史",
                    "summary": "这是根据路线区域和模型知识生成的历史背景。",
                },
            ],
            "warnings": ["测试仅生成两条卡片。"],
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


def test_two_hour_density_targets_twenty_four_cards_with_bounded_research():
    assert narration_density(120) == {"minimum": 20, "target": 24, "maximum": 32}
    assert narration_research_policy(120) == {
        "place_card_maximum": 8,
        "anchor_count": 6,
        "places_per_anchor": 4,
        "search_concurrency": 8,
    }


def test_one_hour_density_does_not_collapse_to_four_cards():
    assert narration_density(57) == {"minimum": 9, "target": 11, "maximum": 19}


def test_route_narration_uses_bounded_places_and_exactly_one_llm_call():
    request = _request()
    request["samples"] = [
        {
            "sample_id": f"sample_{index}",
            "route_distance_m": index * 1000,
            "latitude": 34 + index / 100,
            "longitude": 134 + index / 100,
        }
        for index in range(1, 13)
    ]
    # Keep the IDs used by the fake submission in the selected sample set.
    request["samples"][0]["sample_id"] = "sample_1"
    request["samples"][-1]["sample_id"] = "sample_2"
    places = CountingPlaces()
    llm = OneShotLlm()

    plan = run_route_narration_agent(request, places_client=places, client=llm)

    assert len(places.calls) == 6
    assert len(llm.calls) == 1
    assert len(llm.calls[0]["tools"]) == 1
    assert llm.calls[0]["tools"][0]["name"] == "submit_route_narration_plan"
    assert llm.calls[0]["tool_choice"] == {
        "type": "tool", "name": "submit_route_narration_plan",
    }
    assert llm.calls[0]["thinking"] == "disabled"
    model_payload = json.loads(llm.calls[0]["messages"][0]["content"])
    assert len(model_payload["representative_places"]) == 6
    assert "photos" not in model_payload["representative_places"][0]["places"][0]
    assert plan["schema_version"] == "route_narration_plan.v1"
    assert plan["route_fingerprint"] == "route_1234abcd"
    assert [item["content_scope"] for item in plan["items"]] == ["place", "route"]
    assert plan["items"][0]["media"]["photo_name"] == "places/place_1/photos/photo_1"
    assert plan["items"][1]["sources"] == []


def test_failed_anchor_becomes_warning_without_extra_llm_turn():
    places = CountingPlaces(fail_latitude=34.4)
    llm = OneShotLlm()

    plan = run_route_narration_agent(_request(), places_client=places, client=llm)

    assert len(places.calls) == 2
    assert len(llm.calls) == 1
    assert plan["status"] == "partial"
    assert any("sample_2" in warning and "provider unavailable" in warning for warning in plan["warnings"])


def test_route_cards_need_no_place_source_but_place_cards_require_local_source():
    request = _request()
    sources = {
        "google_place:start": {
            "source_id": "google_place:start",
            "name": "起点景观",
            "sample_ids": ["sample_1"],
            "url": "https://maps.google.test/place",
            "photos": [{"photo_name": "places/place_1/photos/photo_1"}],
        },
    }
    workspace = _NarrationWorkspace(
        request,
        sources,
        generation_policy={"place_card_maximum": 1},
    )
    plan = workspace.build_plan({"items": [
        {
            "sample_id": "sample_1", "content_scope": "place",
            "source_ids": ["google_place:start"],
            "title": "起点地点", "summary": "与起点直接相关。",
        },
        {
            "sample_id": "sample_2", "content_scope": "route",
            "title": "区域历史", "summary": "模型知识提供的区域背景。",
        },
    ]}, density={"minimum": 2, "target": 2, "maximum": 4})

    assert [(item["content_scope"], item["title"]) for item in plan["items"]] == [
        ("place", "起点地点"),
        ("route", "区域历史"),
    ]
    assert plan["items"][0]["media"]["photo_name"] == "places/place_1/photos/photo_1"
    assert plan["items"][1]["sources"] == []


def test_sourced_place_at_another_sample_is_kept_as_route_content():
    workspace = _NarrationWorkspace(
        _request(),
        {
            "google_place:start": {
                "source_id": "google_place:start",
                "name": "起点景观",
                "sample_ids": ["sample_1"],
                "photos": [{"photo_name": "places/place_1/photos/photo_1"}],
            },
        },
        generation_policy={"place_card_maximum": 1},
    )

    plan = workspace.build_plan({"items": [{
        "sample_id": "sample_2", "content_scope": "place",
        "source_ids": ["google_place:start"],
        "title": "区域景观", "summary": "作为区域背景展示，而非当前点位提示。",
    }]}, density={"minimum": 1, "target": 1, "maximum": 2})

    assert plan["items"][0]["content_scope"] == "route"
    assert "media" not in plan["items"][0]
    assert plan["status"] == "ready"


def test_invalid_cards_are_dropped_and_underfilled_plan_returns_without_repair():
    request = _request()
    workspace = _NarrationWorkspace(
        request,
        {},
        generation_policy={"place_card_maximum": 2},
    )
    plan = workspace.build_plan({"items": [
        {
            "sample_id": "sample_1", "content_scope": "place",
            "source_ids": ["invented"], "title": "虚构地点", "summary": "应被丢弃。",
        },
        {
            "sample_id": "sample_2", "content_scope": "route",
            "title": "路线节奏", "summary": "唯一有效的路线级卡片。",
        },
    ]}, density={"minimum": 3, "target": 4, "maximum": 5})

    assert [item["title"] for item in plan["items"]] == ["路线节奏"]
    assert plan["status"] == "partial"
    assert any("少于建议的 3 条" in warning for warning in plan["warnings"])
    assert any("已忽略 1 条" in warning for warning in plan["warnings"])


def test_route_card_with_unknown_explicit_source_is_not_laundered_as_unsourced():
    workspace = _NarrationWorkspace(
        _request(),
        {},
        generation_policy={"place_card_maximum": 2},
    )

    plan = workspace.build_plan({"items": [
        {
            "sample_id": "sample_1",
            "content_scope": "route",
            "source_ids": ["google_place:invented"],
            "title": "伪造来源",
            "summary": "显式引用不存在的资料时不能保留这张卡片。",
        },
        {
            "sample_id": "sample_2",
            "content_scope": "route",
            "title": "无来源区域背景",
            "summary": "没有声明来源的路线级背景仍然允许使用。",
        },
    ]}, density={"minimum": 1, "target": 2, "maximum": 3})

    assert [item["title"] for item in plan["items"]] == ["无来源区域背景"]
    assert plan["items"][0]["sources"] == []
    assert any("已忽略 1 条" in warning for warning in plan["warnings"])


def test_google_place_normalizes_photo_metadata_and_attribution():
    place = _normalize_place({
        "id": "place_1",
        "displayName": {"text": "三都景点"},
        "photos": [{
            "name": "places/place_1/photos/photo_1",
            "widthPx": 1600,
            "heightPx": 900,
            "authorAttributions": [{
                "displayName": "摄影者",
                "uri": "https://maps.google.test/author",
                "photoUri": "https://images.google.test/avatar.jpg",
            }],
        }],
    })

    assert place["photos"] == [{
        "photo_name": "places/place_1/photos/photo_1",
        "width": 1600,
        "height": 900,
        "author_attributions": [{
            "display_name": "摄影者",
            "uri": "https://maps.google.test/author",
            "photo_uri": "https://images.google.test/avatar.jpg",
        }],
    }]


def test_google_place_photo_fetch_is_bounded_and_keeps_key_in_request_params(monkeypatch):
    calls = []

    class FakeResponse:
        ok = True
        status_code = 200
        headers = {"content-type": "image/jpeg; charset=binary"}
        content = b"photo-bytes"

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse()

    monkeypatch.setattr("integrations.google_places.requests.get", fake_get)
    client = GooglePlacesClient("server-key", timeout_seconds=7)
    content, content_type = client.get_photo(
        photo_name="places/place_1/photos/photo_1",
        max_width=640,
    )

    assert content == b"photo-bytes"
    assert content_type == "image/jpeg"
    assert calls == [(
        "https://places.googleapis.com/v1/places/place_1/photos/photo_1/media",
        {"params": {"maxWidthPx": 640, "key": "server-key"}, "timeout": 7},
    )]
