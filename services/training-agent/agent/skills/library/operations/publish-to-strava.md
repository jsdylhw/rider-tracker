---
name: publish-to-strava
description: Publish or refresh local activities on Strava without downloading from Garmin. Use for upload, re-upload, or description-refresh requests involving activities already in the local library.
---

# Publish to Strava

Use `run_activity_workflow` for the requested local range with the `upload_strava` goal. Let the deterministic workflow ensure required reports and preserve idempotent upload state. Set force upload only when the user explicitly requests re-upload or description refresh. Never download Garmin activities in this skill.
