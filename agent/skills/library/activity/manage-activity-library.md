---
name: manage-activity-library
description: Find and inspect activities already stored in the local library. Use for locating one or more activities without analysis, Garmin sync, Strava publishing, or training advice.
---

# Manage Activity Library

Use `resolve_activities` to establish the one collection that should become the user's current navigation range. Use `lookup_activities` for an independent auxiliary query in the same request; it returns the same typed result but never replaces the saved range or focus. Return what is stored; do not generate reports or infer missing metrics.

- Use `kind=recent` for “latest/recent N activities”; do not add a date range.
- Use `kind=date` for one calendar day and `kind=range` for a period. A range `limit`, when requested, is applied after date filtering.
- Use `kind=all` only for explicit all-history requests.
- Use `kind=key`, `kind=index`, or `kind=name` only for an explicit stable identifier, global catalogue index, or name.
- Never mix fields belonging to different kinds.

Treat bare “latest” or “recent” as ordering. Treat an explicit plural count, time period, “all”, or comparison range as multiple activities. Use `navigate_selection` for references such as “the second one”, back, or root instead of resolving the frozen collection again. For example, “recent five's second, then the oldest in all history” is `resolve_activities(recent, 5)` → `navigate_selection(select, 2)` → `lookup_activities(all, earliest, 1)`. Ask one focused question only when two materially different selections remain possible.
