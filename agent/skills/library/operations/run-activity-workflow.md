---
name: run-activity-workflow
description: Start, inspect, retry, or rebuild a recoverable multi-step activity job. Use for combined goals such as sync then analyze or upload, local batch report generation, workflow status, and workflow recovery.
---

# Run Activity Workflow

Choose one coarse workflow tool and pass the user's terminal goals. Do not improvise a sequence of atomic operations in the main-agent loop.

- Use `sync_and_run_activity_workflow` only when Garmin sync is explicitly combined with report generation, aggregation, or Strava upload.
- Preserve the user's explicit cardinality in the structured `count` argument. “最新一个”, “最后一个”, “最新一条”, and “今天最新一个” all require `count=1`; never widen the count merely to find the newest activity. Explicit numbers such as “三个” require that exact count.
- Always provide both `count` and the complete terminal `goals` array in the same `sync_and_run_activity_workflow` call. Analysis/report generation requires `ensure_summary`; Strava publishing requires `upload_strava` as well.
- Set `force_download=true` only for an explicit refresh of an already downloaded Garmin activity. “The phone has synced a new activity” is a normal sync, not a forced refresh.
- Use `run_activity_workflow` for local activities already present in SQLite.
- Use the report rebuild job for an explicit bulk rebuild.
- Use get or retry tools with the persisted identifier for status and recovery.

Report the persisted workflow or job status. Do not claim completion from a submitted or partial state.
