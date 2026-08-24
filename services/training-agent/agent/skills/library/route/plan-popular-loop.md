---
name: plan-popular-loop
description: Build a domestic ride around one complete popular Strava loop with ordinary map-routed access from and back to the requested origin.
---

# Plan Popular Loop

Use this Skill when the user identifies a classic loop by name or gives an origin plus a clear loop area, for example “从夫子庙出发环陵” or “从家出发骑一圈环金鸡湖热门环线”.

Call `create_popular_loop` once to produce a verified draft:

- `origin` is the real start and finish.
- `area` is a searchable landmark near the loop, not a fabricated road point.
- Put a user-supplied loop/corridor phrase such as `环陵` in `segment_name_hint`. Omit it when the user names only an area.
- The service searches a bounded Strava Explorer sample, verifies up to three complete closed Segments, and preserves each full geometry as a separate candidate. AMap only supplies the outbound and return connectors.
- `target_distance_km` includes both connectors and the complete loop; report actual distance.
- Keep `fallback_to_provider=true` unless the user explicitly requires Strava evidence. A fallback is an ordinary AMap out-and-back and must be described as such, never as a verified popular loop.
- Treat the result as awaiting selection until the user explicitly confirms it. Use `select_candidate` to preview, `confirm_candidate` to save, and never treat a short open climb whose endpoints merely happen to be nearby as a closed loop.

Use `get_route_plan` to restore the result. `reverse_candidate` and `undo` are valid follow-up edits; when origin, area, or named loop changes, call `create_popular_loop` again rather than replacing generic waypoints.

Treat Strava popularity and Google elevation as reference evidence. Do not claim road safety, current traffic, access permission, or exact on-road grade.
