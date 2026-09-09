---
name: plan-routes
description: Create and iteratively edit verified cycling routes from explicit waypoints or an open-ended riding request.
---

# Plan Routes

Use this Skill whenever the user wants an actual route, not merely training-type advice.

## Create the first draft

- If the user gives explicit endpoints or waypoints, preserve their order and call `create_route_plan` once. Do not close the route unless the user explicitly asks to return, ride a loop, or finish at the start.
- If the request is open-ended, infer one to three plausible, searchable waypoint skeletons from the requested start or region, direction, distance, terrain, and scenery. Submit all alternatives in one `create_route_plan` call.
- A start plus “ride a loop and return” and a target distance is sufficient. Do not require the user to invent intermediate points.
- Route shape is expressed only by waypoint order. A point-to-point route has different first and last waypoints. A loop must repeat the exact starting query as its final waypoint. Never send a separate route-type guess.
- Set `target_distance_km` only when the user supplied a numeric target or range. Do not invent a target from a famous route's expected length; an explicit waypoint route without a requested distance must be accepted at its provider distance.
- “不走重复路”“不要原路返回”“去回程分开”是确定性路线约束：必须传入 `route_constraints.avoid_repeated_roads=true`，通常保留 `maximum_self_overlap_ratio=0.1`。不得只把要求写进路线名称、理由或 `segment_preferences`。
- If the user explicitly wants one named or area-specific complete popular loop, call `create_route_plan` with `segment_strategy=complete_loop`, `origin`, `area`, and any genuine `segment_name_hint`.
- Use `create_itinerary_plan` only for multiple days or one day split into stages.

Ordinary routes default to `segment_strategy=auto`: the map provider verifies each skeleton, then the service may replace that baseline with a usable Strava-backed composition. If discovery, selection, or composition fails, the verified map route remains. Use `require` only when the user explicitly requires Strava evidence; use `ignore` when they explicitly do not want it.

Mainland China uses AMap routing; other countries use Google Places and Google Routes. The service resolves the repeated loop origin only once and closes it with the exact starting coordinate. Report actual provider distance rather than pretending the target was met. Never report rejected or unresolved candidates as routes.

## Continue the conversation

The initial result is a draft. Present at most three candidates and wait for selection or semantic edits.

- Use `select_candidate` to change the preview and `confirm_candidate` only after explicit confirmation.
- Use `replace_waypoint`, `replace_waypoints`, `replace_stage`, deterministic reversal, or `undo` for follow-up edits.
- 后续提出避免重复道路时，使用 `update_route_plan` 的同一个 `route_constraints` 结构，并通过 `replace_waypoint` 或 `replace_waypoints` 给出新的骨架。服务端会校验地图最终轨迹；超过阈值的候选会被拒绝，不能把工具成功等同于要求已满足。
- Use `explore_route_segments` when the user wants to inspect nearby Strava material.
- Use `compose_segments` only with real Segment IDs already stored in the current plan's discovered pool. Preserve the requested segment order; never invent IDs.
- Restart creation only when the requested geography or route concept materially changes.

Elevation and Strava popularity are reference evidence. Do not claim live traffic, road safety, access permission, street-view continuity, or exact surface grade.
