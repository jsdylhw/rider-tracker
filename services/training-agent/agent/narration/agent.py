"""Independent sourced route-narration tool loop."""

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
from integrations.llm import AnthropicMessagesClient, build_tool_result_block, extract_text
from services.narration.density import narration_density, narration_research_policy
from settings import load_config


def run_route_narration_agent(
    request: dict[str, Any], *,
    places_client: GooglePlacesClient | None = None,
    client: AnthropicMessagesClient | None = None,
) -> dict[str, Any]:
    samples = request.get("samples") if isinstance(request.get("samples"), list) else []
    if len(samples) < 2:
        raise ValueError("At least two route samples are required.")
    config = load_config()
    google = config.get("google") if isinstance(config.get("google"), dict) else {}
    places_client = places_client or GooglePlacesClient(str(google.get("api_key") or ""))
    client = client or AnthropicMessagesClient()
    registry = ToolRegistry(ROUTE_NARRATION_TOOLS)
    density = narration_density(request.get("estimated_duration_min"))
    research_policy = narration_research_policy(request.get("estimated_duration_min"))
    workspace = _NarrationWorkspace(request, places_client, research_policy=research_policy)
    messages: list[dict[str, Any]] = [{
        "role": "user",
        "content": json.dumps({
            "instruction": "Research this route and submit the complete narration plan.",
            "route": {
                "name": request["route_name"],
                "total_distance_m": request["total_distance_m"],
                "estimated_duration_min": request["estimated_duration_min"],
                "locale": request.get("locale") or "zh-CN",
            },
            "density": density,
            "research_policy": research_policy,
            "samples": samples,
        }, ensure_ascii=False),
    }]

    max_steps = min(12, max(6, (research_policy["search_request_maximum"] + 1) // 2 + 3))
    for _step in range(max_steps):
        response = client.create_messages(
            system=ROUTE_NARRATION_SYSTEM_PROMPT,
            messages=messages,
            max_tokens=8000,
            temperature=0.2,
            tools=registry.to_anthropic(),
        )
        messages.append({"role": "assistant", "content": response.get("content") or []})
        tool_results = []
        for block in response.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = str(block.get("name") or "")
            args = block.get("input") if isinstance(block.get("input"), dict) else {}
            if name == "submit_route_narration_plan":
                try:
                    return workspace.build_plan(args, density=density)
                except ValueError as exc:
                    # A model may use an unread source or accidentally treat a
                    # regional card as a point card. Return the contract error
                    # to the same tool loop so it can repair the submission
                    # without repeating the external research.
                    tool_results.append({
                        **build_tool_result_block(
                            block["id"],
                            json.dumps({
                                "error": "invalid_narration_plan",
                                "message": str(exc),
                                "hint": (
                                    "Reuse read source_ids. Use content_scope=route when the source "
                                    "supports regional content but was found at another sample."
                                ),
                            }, ensure_ascii=False),
                        ),
                        "is_error": True,
                    })
                    continue
            try:
                if name == "search_route_knowledge":
                    output = workspace.search(args)
                elif name == "read_route_source":
                    output = workspace.read(args)
                else:
                    output = {"error": "unknown_tool", "name": name}
                tool_results.append(build_tool_result_block(
                    block["id"], json.dumps(output, ensure_ascii=False, default=str),
                ))
            except Exception as exc:
                tool_results.append({
                    **build_tool_result_block(
                        block["id"],
                        json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False),
                    ),
                    "is_error": True,
                })
        if tool_results:
            messages.append({"role": "user", "content": tool_results})
            continue
        messages.append({
            "role": "user",
            "content": (
                "Continue the research with tools, or call submit_route_narration_plan. "
                f"Do not answer as plain text. Previous text: {extract_text(response)[:300]}"
            ),
        })
    raise RuntimeError("RouteNarrationAgent did not submit a plan within its tool budget.")


class _NarrationWorkspace:
    def __init__(
        self,
        request: dict[str, Any],
        places_client: Any,
        *,
        research_policy: dict[str, int],
    ) -> None:
        self.request = request
        self.places_client = places_client
        self.research_policy = research_policy
        self.samples = {str(item["sample_id"]): item for item in request["samples"]}
        self.sources: dict[str, dict[str, Any]] = {}
        self.read_ids: set[str] = set()
        self.search_requests_used = 0
        self.search_cache: dict[tuple[str, float, float, int], list[dict[str, Any]]] = {}

    def search(self, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        limit = max(1, min(6, int(args.get("limit_per_sample") or 4)))
        requested_ids = list(dict.fromkeys(str(value) for value in args.get("sample_ids") or []))[:8]
        sample_ids = _representative_values(
            requested_ids,
            self.research_policy["samples_per_search"],
        )
        remaining = max(
            0,
            self.research_policy["search_request_maximum"] - self.search_requests_used,
        )
        searches: list[tuple[str, dict[str, Any], tuple[str, float, float, int]]] = []
        cached_results: list[tuple[str, list[dict[str, Any]]]] = []
        for sample_id in sample_ids:
            sample = self.samples.get(sample_id)
            if not sample:
                continue
            cache_key = (
                query.casefold(),
                round(float(sample["latitude"]), 3),
                round(float(sample["longitude"]), 3),
                limit,
            )
            if cache_key in self.search_cache:
                cached_results.append((sample_id, self.search_cache[cache_key]))
            elif len(searches) < remaining:
                searches.append((sample_id, sample, cache_key))

        fetched: list[tuple[str, list[dict[str, Any]]]] = []
        errors: list[dict[str, str]] = []
        if searches:
            self.search_requests_used += len(searches)
            workers = min(self.research_policy["search_concurrency"], len(searches))
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="narration-places") as executor:
                future_searches = {
                    executor.submit(
                        self.places_client.search_near_route_point,
                        query=query,
                        latitude=float(sample["latitude"]),
                        longitude=float(sample["longitude"]),
                        limit=limit,
                    ): (sample_id, cache_key)
                    for sample_id, sample, cache_key in searches
                }
                for future in as_completed(future_searches):
                    sample_id, cache_key = future_searches[future]
                    try:
                        sources = future.result()
                    except Exception as exc:  # A failed place must not discard the whole batch.
                        errors.append({"sample_id": sample_id, "message": str(exc)[:300]})
                        continue
                    self.search_cache[cache_key] = sources
                    fetched.append((sample_id, sources))

        results = []
        result_groups = [*cached_results, *fetched]
        result_groups.sort(key=lambda item: sample_ids.index(item[0]))
        for sample_id, sources in result_groups:
            for source in sources:
                source_id = str(source.get("source_id") or "")
                if not source_id:
                    continue
                previous = self.sources.get(source_id) or {}
                associated_sample_ids = list(dict.fromkeys([
                    *previous.get("sample_ids", []),
                    sample_id,
                ]))
                normalized = {**previous, **source, "sample_ids": associated_sample_ids}
                self.sources[source_id] = normalized
                results.append({
                    "source_id": source_id,
                    "sample_id": sample_id,
                    "name": normalized.get("name"),
                    "address": normalized.get("address"),
                    "primary_type": normalized.get("primary_type"),
                    "summary": normalized.get("summary"),
                })
        return {
            "query": query,
            "searched_sample_ids": [sample_id for sample_id, _sources in result_groups],
            "results": results[:40],
            "errors": errors,
            "research_budget": {
                "used": self.search_requests_used,
                "maximum": self.research_policy["search_request_maximum"],
                "remaining": max(
                    0,
                    self.research_policy["search_request_maximum"] - self.search_requests_used,
                ),
            },
        }

    def read(self, args: dict[str, Any]) -> dict[str, Any]:
        records = []
        for source_id in list(dict.fromkeys(str(value) for value in args.get("source_ids") or []))[:20]:
            source = self.sources.get(source_id)
            if source:
                self.read_ids.add(source_id)
                records.append(source)
        return {"sources": records}

    def build_plan(self, submission: dict[str, Any], *, density: dict[str, int]) -> dict[str, Any]:
        items = []
        seen_samples: set[str] = set()
        place_card_count = 0
        skipped_place_cards = 0
        for index, raw in enumerate(submission.get("items") or []):
            if not isinstance(raw, dict):
                continue
            sample_id = str(raw.get("sample_id") or "")
            sample = self.samples.get(sample_id)
            content_scope = str(raw.get("content_scope") or "place").lower()
            if content_scope not in {"route", "place"}:
                content_scope = "place"
            source_ids = [
                str(value) for value in raw.get("source_ids") or []
                if str(value) in self.sources
                and str(value) in self.read_ids
                and (
                    content_scope == "route"
                    or sample_id in self.sources[str(value)].get("sample_ids", [])
                )
            ]
            title = str(raw.get("title") or "").strip()
            summary = str(raw.get("summary") or "").strip()
            if not sample or not source_ids or not title or not summary or sample_id in seen_samples:
                continue
            if content_scope == "place":
                if place_card_count >= self.research_policy["place_card_maximum"]:
                    skipped_place_cards += 1
                    continue
                place_card_count += 1
            seen_samples.add(sample_id)
            items.append({
                "item_id": f"narration_{index + 1}",
                "route_distance_m": sample["route_distance_m"],
                "latitude": sample["latitude"],
                "longitude": sample["longitude"],
                "content_scope": content_scope,
                "category": str(raw.get("category") or "place")[:40],
                "title": title[:80],
                "summary": summary[:600],
                "tts_text": str(raw.get("tts_text") or summary).strip()[:300],
                "trigger": {
                    "lead_distance_m": 300,
                    "expire_distance_m": 500,
                    "minimum_gap_seconds": 75,
                    "priority": _bounded_number(raw.get("priority"), 0, 10, 5),
                },
                "sources": [self.sources[source_id] for source_id in source_ids],
            })
        if not items:
            raise ValueError(
                "submit_route_narration_plan contains no valid sourced cards "
                f"(known_sources={len(self.sources)}, read_sources={len(self.read_ids)})"
            )
        items.sort(key=lambda item: item["route_distance_m"])
        warnings = [str(value) for value in submission.get("warnings") or [] if str(value).strip()]
        if skipped_place_cards:
            warnings.append(
                f"已忽略 {skipped_place_cards} 条超出上限的点位卡片；"
                f"点位卡片最多 {self.research_policy['place_card_maximum']} 条。"
            )
        if len(items) < density["minimum"]:
            warnings.append(f"有效资料只支持 {len(items)} 条卡片，少于建议的 {density['minimum']} 条。")
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
            "warnings": warnings,
        }


def _bounded_number(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return fallback


def _representative_values(values: list[str], maximum: int) -> list[str]:
    """Keep evenly distributed values while preserving their original order."""
    if len(values) <= maximum:
        return values
    if maximum <= 1:
        return values[:1]
    indexes = [round(index * (len(values) - 1) / (maximum - 1)) for index in range(maximum)]
    return [values[index] for index in dict.fromkeys(indexes)]
