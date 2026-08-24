---
name: analyze-training-history
description: Summarize, compare, or calculate trends across multiple activities using structured metrics. Use for recent ranges, weekly or monthly load, progress, consistency, fatigue signals, and matched-session comparisons.
---

# Analyze Training History

Resolve the requested range once with a typed `resolve_activities` call; successful resolution freezes its activity order. Use `kind=recent` for a count, `kind=range` for a period, and `kind=all` only for explicit all-history requests. A requested range limit belongs in that same call and is applied after filtering.

Translate the request into one or more evidence claims: volume, intensity, performance, efficiency, consistency, or possible recovery strain. For a longitudinal conclusion call `analyze_training_history`; it returns the stable `training_history_analysis.v1` contract used by the Web UI. Use `calculate_history_metrics` only when the user asks for raw weekly/monthly series, `summarize_recent_training_load` for load-only facts, and `compare_activities` for an explicit finite activity comparison. Use `inspect_selection` for a report-free collection overview. Use `summarize_activities` only when stored report narratives are explicitly useful.

Use `navigate_selection` for "the second one" and similar follow-ups. Never call a single-activity report tool once per item in the range, and never generate missing reports merely to inspect a collection.

Read structured activity metrics rather than extracting numbers from generated prose. Separate sports unless the user explicitly asks for combined volume; never compare cycling watts with running pace. Distinguish observed changes from interpretation and state coverage, missing sensors, threshold/load-method changes, and confounders before claiming fitness or fatigue.

`scope.current_period` is the latest period containing selected data, not automatically the present calendar period. Respect its `status` and `as_of` fields: never call a `closed` period "still in progress". If its activity coverage is sparse, say how many activities/active days were observed or that no later activity is recorded; do not change the calendar status.

Follow the loaded methodology and output contract. A load increase alone is not fitness improvement, and one poor session is not accumulated fatigue. When matched sessions, steady efficiency evidence, subjective recovery, weather, or route context are unavailable, mark those dimensions unavailable. Do not invent them. Every major conclusion needs a confidence level and the main limitation.
