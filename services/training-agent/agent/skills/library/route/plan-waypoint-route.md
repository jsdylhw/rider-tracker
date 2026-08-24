---
name: plan-waypoint-route
description: Create and edit routes with explicit endpoints, waypoint sequences, days, or day parts.
---

# Plan Waypoint Route

Use `create_route_plan` for a concrete single-day route with one to three meaningfully different waypoint sequences. Use `create_itinerary_plan` for multiple days or one day split into morning and afternoon.

When alternatives are requested, submit them together in one tool call's `candidates` array. Never create one independent plan per candidate.

- Mainland China uses AMap bicycling; other countries use Google Places and Google Routes.
- A `loop` closes itself. Never repeat the first waypoint at the end.
- Every landmark or corridor explicitly required by the user must be an explicit waypoint.
- `target_distance_km` is a target; report provider-returned distance.
- For mainland China, the first plan keeps the provider baseline and may add separate Strava-backed candidates between hard waypoint anchors. Present the candidates and wait for selection; do not describe a draft as final.
- `select_candidate` changes the current preview. `confirm_candidate` is required only when the user explicitly confirms or saves the route.
- Use `compose_segments` when the user asks to ride named displayed Segments such as A+B. Resolve names only to Segment IDs already present in the saved route's discovered pool; array order is riding order and the service computes every connector.
- After a candidate is selected, prefer incremental edits of that candidate. Do not repeat broad Strava discovery unless the user moves the route to a new area, asks for different popular roads, or the saved pool cannot satisfy the request.
- For staged plans, adjacent stage endpoints must remain within the handoff tolerance. A short transfer does not require selecting a hotel.

Use `update_route_plan` for follow-up edits: `replace_waypoint`, `replace_waypoints`, `replace_stage`, deterministic `reverse_candidate` or `reverse_stage`, `select_candidate`, `compose_segments`, `confirm_candidate`, and `undo`. Use `get_route_plan` to restore the latest saved plan. Use `explore_route_segments` when the user asks to see nearby Strava context or the saved route does not yet have a reusable Segment pool.

Elevation is reference enrichment only. Do not claim live traffic, road safety, street-view continuity, or exact surface grade.
