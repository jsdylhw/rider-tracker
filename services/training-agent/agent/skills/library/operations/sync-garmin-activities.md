---
name: sync-garmin-activities
description: Download recent Garmin activities into the local library and stop. Use only for pure sync or download requests that do not also request analysis, reports, summaries, or Strava upload.
---

# Sync Garmin Activities

Call `sync_garmin_activities` once with the requested count. This operation downloads and indexes activities only. Do not generate reports, invoke an analysis agent, publish to Strava, or create a multi-step workflow.

Preserve explicit cardinality in the structured `count` argument. “最新一个”, “最后一个”, “最新一条”, and “今天最新一个” require `count=1`; explicit numbers such as “三个” require that exact count. Never widen the count to search for the newest activity.

Set `force_download=true` only when the user explicitly says an already downloaded Garmin activity itself was edited or asks to refresh its original FIT. A newly synced phone activity uses the normal path.
