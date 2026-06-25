---
name: project-feature-opportunities
description: "Feature development opportunities identified during 2026-05-14 codebase audit, organized by priority tier"
metadata: 
  node_type: memory
  type: project
  originSessionId: c6b744bf-ae5b-446c-816b-c892c6b0e060
---

## Tier 1 — Core Training Features (highest user value)

1. **Structured interval training** — Add "Interval Group" abstraction (step list + repeat count) to `src/domain/workout/custom-workout-target.js`. Current steps are linear only. Enable "3× 8min @ 105% FTP with 4min rest" patterns.
2. **FTP power zones and time-in-zone stats** — Implement Z1-Z7 power zones and Z1-Z5 HR zones. Show zone distribution in activity detail and post-ride summary. Build on existing `power-metrics.js`.
3. **Peak power curve** — "Best Power" chart: max average power for any duration (5s, 1min, 5min, 20min, 1h). Core training analysis tool.
4. **Dynamic workout step progression** — Auto-advance ERG target power based on elapsed time when custom workout target is enabled. Currently the plan is display-only; the trainer does not follow steps.

## Tier 2 — Ride Experience

5. **ERG power ramping** — Smooth 5-10s transitions between ERG target power changes instead of instant jumps. Add safety cap on target power.
6. **Drafting model** — Add drafting drag reduction to `src/domain/physics/cycling-model.js` for future multi-rider / virtual race features.
7. **Altitude-adjusted air density** — Compute ρ dynamically from route elevation in physics model. Currently hardcoded 1.226 kg/m³; at 2000m density drops ~18%, significantly affecting simulated speed.
8. **Auto FTP detection** — Compute FTP estimate from best 20-min average power × 0.95 and suggest profile update.

## Tier 3 — UI & UX

9. **Activity history pagination / infinite scroll** — Currently limited to 12 most recent activities (`src/ui/renderers/activity-history-renderer.js`).
10. **Persist metric customizer selections** — Dashboard metric chip selection resets on page refresh.
11. **Street View gradient overlay** — Add semi-transparent gradient overlay for text readability on bright Street View backgrounds.
12. **Ride pause/resume** — Pause timer and physics loop without ending the ride session.

## Tier 4 — Platform & Security

13. **Basic authentication** — API key or password auth on server endpoints.
14. **CSRF protection + CORS restriction** — Limit CORS origins and add CSRF tokens.
15. **Encrypted OAuth token storage** — Use `crypto.createCipheriv` with env-var key for at-rest token encryption.
16. **Helmet security headers** — Add `helmet` middleware to Express server.

**Why:** Identified during systematic audit of all 89 source files across all layers (domain, app, adapters, UI, server).
**How to apply:** When planning new feature work, reference these tiers to prioritize. Tier 1 items are most impactful for the cycling/training use case.
