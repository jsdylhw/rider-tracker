---
name: discover-routes
description: Create real route candidates from an open-ended start or region, duration, distance, direction, terrain, scenery, or riding goal.
---

# Discover Routes

Use this Skill when the user asks for an actual route but has not supplied a complete waypoint skeleton. Convert the stated start or region, direction, distance/time, terrain, scenery, and riding goal into one to three searchable waypoint skeletons, then call a route-creation tool in the same turn. Do not stop at generic training or terrain advice.

- A start plus a loop requirement and target distance is sufficient for discovery, for example “从 A 出发骑一圈 50km 再回来”. Create `loop` candidates anchored at A; the user does not need to name intermediate waypoints first.
- A start plus a direction, terrain, and distance is also sufficient, for example “从杭州西站出发，往西北找一条 80-100km 爬坡路线”. Propose real searchable landmarks in that corridor and let the map provider verify them.
- Ask one focused clarification only when the start/region itself is ambiguous enough to materially change the route. Preserve the user's place text; never silently reduce a specific but unresolved place to a city name.
- Questions that only ask what type, distance, or intensity to train belong to `coach-training`, not this Skill.

- When a selected idea is a named or area-specific classic closed loop in mainland China, call `create_popular_loop`.
- When the selected idea has explicit endpoints or waypoints, call `create_route_plan`.
- When the selected idea spans days or morning/afternoon stages, call `create_itinerary_plan`.
- Use plausible named landmarks as candidate hypotheses, but report only provider-resolved routes as actual candidates. Ask for a start point when it materially changes the route.
- Offer at most three meaningfully different complete-route candidates and distinguish their actual distance, duration, terrain intent, provider warnings, and included Strava Segments. Users choose routes, while displayed Segments are reusable route material and evidence.
- For the initial open-ended discovery, put all 2-3 alternatives in the `candidates` array of one `create_route_plan` call. Do not call `create_route_plan` once per alternative and do not repeat the tool merely to restate the same route.
- The first route creation is a draft awaiting selection. After the user selects one candidate, edit that route incrementally instead of restarting broad discovery; restart only when the requested geography or route concept materially changes.

Use `update_route_plan` for subsequent concrete edits, explicit Segment composition, selection, confirmation, and undo. Use `get_route_plan` to restore a saved draft or confirmed plan.
