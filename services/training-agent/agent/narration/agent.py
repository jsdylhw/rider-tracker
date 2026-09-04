"""Prepare a route narration plan with bounded research and one LLM call.

Google Places is queried deterministically at a small number of representative
route anchors. The complete research bundle is then handed to the model once
for composition. Card count must not multiply search or model requests.
"""

from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from agent.narration.catalog import ROUTE_NARRATION_TOOLS
from agent.narration.prompts import ROUTE_NARRATION_SYSTEM_PROMPT
from agent.tools.spec import ToolRegistry
from domain.contracts.schemas import ROUTE_NARRATION_PLAN_V1
from integrations.google_places import GooglePlacesClient
from integrations.llm import AnthropicMessagesClient, extract_text
from services.narration.density import narration_density, narration_research_policy
from settings import load_config


def run_route_narration_agent(
    request: dict[str, Any], *,
    places_client: GooglePlacesClient | None = None,
    client: AnthropicMessagesClient | None = None,
) -> dict[str, Any]:
    """Research representative places, then compose the whole plan once."""
    samples = request.get("samples") if isinstance(request.get("samples"), list) else []
    if len(samples) < 2:
        raise ValueError("At least two route samples are required.")

    config = load_config()
    google = config.get("google") if isinstance(config.get("google"), dict) else {}
    places_client = places_client or GooglePlacesClient(str(google.get("api_key") or ""))
    client = client or AnthropicMessagesClient()
    density = narration_density(request.get("estimated_duration_min"))
    generation_policy = narration_research_policy(request.get("estimated_duration_min"))
    research = _research_route_places(request, places_client, policy=generation_policy)

    response = client.create_messages(
        system=ROUTE_NARRATION_SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": json.dumps({
                "instruction": "Compose and submit the complete narration plan now.",
                "route": {
                    "name": request["route_name"],
                    "total_distance_m": request["total_distance_m"],
                    "estimated_duration_min": request["estimated_duration_min"],
                    "duration_estimation": request.get("duration_estimation"),
                    "locale": request.get("locale") or "zh-CN",
                },
                "density": density,
                "generation_policy": generation_policy,
                "samples": samples,
                "representative_places": research["anchors"],
                "research_warnings": research["warnings"],
            }, ensure_ascii=False),
        }],
        max_tokens=8000,
        temperature=0.2,
        tools=ToolRegistry(ROUTE_NARRATION_TOOLS).to_anthropic(),
        tool_choice={"type": "tool", "name": "submit_route_narration_plan"},
        thinking="disabled",
    )
    workspace = _NarrationWorkspace(
        request,
        research["sources"],
        generation_policy=generation_policy,
        research_warnings=research["warnings"],
    )
    return workspace.build_plan(_extract_submission(response), density=density)


def _research_route_places(
    request: dict[str, Any],
    places_client: Any,
    *,
    policy: dict[str, int],
) -> dict[str, Any]:
    """Run one Places search per representative anchor, concurrently."""
    anchors = _representative_values(
        request["samples"], min(policy["anchor_count"], len(request["samples"])),
    )
    route_name = str(request.get("route_name") or "骑行路线").strip()
    query = f"{route_name} 周边 景点 历史文化 自然风景"
    results_by_index: dict[int, list[dict[str, Any]]] = {}
    errors_by_index: dict[int, str] = {}
    workers = min(policy["search_concurrency"], len(anchors))

    with ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="narration-places") as executor:
        pending = {
            executor.submit(
                places_client.search_near_route_point,
                query=query,
                latitude=float(sample["latitude"]),
                longitude=float(sample["longitude"]),
                limit=policy["places_per_anchor"],
            ): index
            for index, sample in enumerate(anchors)
        }
        for future in as_completed(pending):
            index = pending[future]
            try:
                value = future.result()
                results_by_index[index] = value if isinstance(value, list) else []
            except Exception as exc:  # One bad anchor must not discard all research.
                errors_by_index[index] = str(exc)[:300]

    sources: dict[str, dict[str, Any]] = {}
    anchor_payloads = []
    for index, sample in enumerate(anchors):
        sample_id = str(sample["sample_id"])
        places = []
        for raw in results_by_index.get(index, []):
            if not isinstance(raw, dict):
                continue
            source_id = str(raw.get("source_id") or "").strip()
            if not source_id or source_id == "google_place:":
                continue
            previous = sources.get(source_id) or {}
            sample_ids = list(dict.fromkeys([*previous.get("sample_ids", []), sample_id]))
            normalized = {**previous, **raw, "sample_ids": sample_ids}
            sources[source_id] = normalized
            places.append(_source_for_model(normalized))
        anchor_payloads.append({
            "sample": sample,
            "places": places,
            "search_error": errors_by_index.get(index),
        })

    warnings = [
        f"代表点 {anchors[index]['sample_id']} 的地点检索失败：{message}"
        for index, message in sorted(errors_by_index.items())
    ]
    if not sources:
        warnings.append("Google Places 未返回可用地点；本次仅生成路线级背景讲解。")
    return {"anchors": anchor_payloads, "sources": sources, "warnings": warnings}


def _source_for_model(source: dict[str, Any]) -> dict[str, Any]:
    """Exclude bulky photo metadata from the LLM context."""
    return {key: value for key, value in source.items() if key not in {"photos", "types"}}


def _extract_submission(response: dict[str, Any]) -> dict[str, Any]:
    """Read the single structured submission, with a JSON-text fallback."""
    for block in response.get("content") or []:
        if (
            isinstance(block, dict)
            and block.get("type") == "tool_use"
            and block.get("name") == "submit_route_narration_plan"
            and isinstance(block.get("input"), dict)
        ):
            return block["input"]

    text = extract_text(response).strip()
    if text.startswith("```"):
        lines = text.splitlines()
        lines = lines[1:] if lines and lines[0].startswith("```") else lines
        lines = lines[:-1] if lines and lines[-1].strip() == "```" else lines
        text = "\n".join(lines).strip()
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            "Route narration model did not return submit_route_narration_plan."
        ) from exc
    if not isinstance(parsed, dict) or not isinstance(parsed.get("items"), list):
        raise RuntimeError("Route narration model returned an invalid plan payload.")
    return parsed


class _NarrationWorkspace:
    """Validate model output and attach trusted provider metadata."""

    def __init__(
        self,
        request: dict[str, Any],
        sources: dict[str, dict[str, Any]],
        *,
        generation_policy: dict[str, int],
        research_warnings: list[str] | None = None,
    ) -> None:
        self.request = request
        self.sources = sources
        self.generation_policy = generation_policy
        self.research_warnings = list(research_warnings or [])
        self.samples = {str(item["sample_id"]): item for item in request["samples"]}

    def build_plan(self, submission: dict[str, Any], *, density: dict[str, int]) -> dict[str, Any]:
        items = []
        seen_samples: set[str] = set()
        place_card_count = 0
        skipped_invalid_cards = 0

        for index, raw in enumerate(submission.get("items") or []):
            if len(items) >= density["maximum"]:
                break
            if not isinstance(raw, dict):
                skipped_invalid_cards += 1
                continue
            sample_id = str(raw.get("sample_id") or "")
            sample = self.samples.get(sample_id)
            content_scope = str(raw.get("content_scope") or "route").lower()
            if content_scope not in {"route", "place"}:
                content_scope = "route"
            title = str(raw.get("title") or "").strip()
            summary = str(raw.get("summary") or "").strip()
            if not sample or not title or not summary or sample_id in seen_samples:
                skipped_invalid_cards += 1
                continue

            requested_source_ids = list(dict.fromkeys(
                str(value) for value in raw.get("source_ids") or []
            ))
            source_ids = [value for value in requested_source_ids if value in self.sources]
            # A route-level card may intentionally have no sources, but an
            # explicit provider reference must be fully trustworthy. Dropping
            # unknown IDs and retaining the prose would silently turn a forged
            # citation into an apparently valid unsourced card.
            if len(source_ids) != len(requested_source_ids):
                skipped_invalid_cards += 1
                continue
            if content_scope == "place":
                local_source_ids = [
                    value for value in source_ids
                    if sample_id in self.sources[value].get("sample_ids", [])
                ]
                if not source_ids:
                    skipped_invalid_cards += 1
                    continue
                if local_source_ids and place_card_count < self.generation_policy["place_card_maximum"]:
                    source_ids = local_source_ids
                    place_card_count += 1
                else:
                    # Keep useful regional material, but remove the precise
                    # point/photo claim when its source is not local to this
                    # sample or the place-card budget is already full.
                    content_scope = "route"

            seen_samples.add(sample_id)
            item = {
                "item_id": f"narration_{index + 1}",
                "route_distance_m": sample["route_distance_m"],
                "latitude": sample["latitude"],
                "longitude": sample["longitude"],
                "content_scope": content_scope,
                "category": str(raw.get("category") or "route")[:40],
                "title": title[:80],
                "summary": summary[:600],
                "tts_text": str(raw.get("tts_text") or summary).strip()[:300],
                "trigger": {
                    "lead_distance_m": 300,
                    "expire_distance_m": 500,
                    "minimum_gap_seconds": 75,
                    "priority": _bounded_number(raw.get("priority"), 0, 10, 5),
                },
                "sources": [
                    {key: value for key, value in self.sources[source_id].items() if key != "photos"}
                    for source_id in source_ids
                ],
            }
            media = self._place_photo(source_ids) if content_scope == "place" else None
            if media is not None:
                item["media"] = media
            items.append(item)

        if not items:
            raise ValueError(
                "submit_route_narration_plan contains no valid cards "
                f"(known_sources={len(self.sources)})"
            )

        items.sort(key=lambda item: item["route_distance_m"])
        warnings = [*self.research_warnings]
        warnings.extend(
            str(value) for value in submission.get("warnings") or [] if str(value).strip()
        )
        if skipped_invalid_cards:
            warnings.append(f"已忽略 {skipped_invalid_cards} 条格式或来源关联无效的卡片。")
        if len(items) < density["minimum"]:
            warnings.append(f"本次生成 {len(items)} 条有效卡片，少于建议的 {density['minimum']} 条。")

        return {
            "schema_version": ROUTE_NARRATION_PLAN_V1,
            "plan_id": f"narration_{uuid.uuid4().hex}",
            "route_fingerprint": self.request["route_fingerprint"],
            "locale": self.request.get("locale") or "zh-CN",
            "status": "partial" if warnings else "ready",
            "content_profile": "route_narration_agent",
            "route": {
                "name": self.request["route_name"],
                "total_distance_m": self.request["total_distance_m"],
            },
            "items": items,
            "warnings": list(dict.fromkeys(warnings)),
        }

    def _place_photo(self, source_ids: list[str]) -> dict[str, Any] | None:
        for source_id in source_ids:
            source = self.sources.get(source_id) or {}
            photos = source.get("photos") if isinstance(source.get("photos"), list) else []
            photo = photos[0] if photos and isinstance(photos[0], dict) else None
            if not photo or not str(photo.get("photo_name") or "").strip():
                continue
            return {
                "type": "google_place_photo",
                "photo_name": str(photo["photo_name"]),
                "width": photo.get("width"),
                "height": photo.get("height"),
                "author_attributions": photo.get("author_attributions") or [],
                "source_url": str(source.get("url") or ""),
            }
        return None


def _bounded_number(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return fallback


def _representative_values(values: list[Any], maximum: int) -> list[Any]:
    """Keep evenly distributed values while preserving their original order."""
    if len(values) <= maximum:
        return values
    if maximum <= 1:
        return values[:1]
    indexes = [round(index * (len(values) - 1) / (maximum - 1)) for index in range(maximum)]
    return [values[index] for index in dict.fromkeys(indexes)]
