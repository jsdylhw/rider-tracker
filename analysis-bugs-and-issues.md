---
name: project-bugs-and-issues
description: "Known bugs, race conditions, and security issues discovered during codebase audit (2026-05-14)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c6b744bf-ae5b-446c-816b-c892c6b0e060
---

## Critical / High Risk

1. **No server authentication** — All API endpoints (`src/server/routes/`) are publicly accessible: read/write/delete activities, upload to Strava, modify user profile. No session, token, or API key check.
2. **Open CORS** — `app.use(cors())` in `src/server/index.js` with no options allows any origin, enabling CSRF on all endpoints.
3. **Plaintext Strava OAuth tokens on disk** — `src/server/token-store.js` and `config-store.js` store `access_token`, `refresh_token`, and `clientSecret` as plain JSON.
4. **Race condition in `startRide()`** — `src/app/services/ride-service.js` calls `restartLiveRideLoop()` before `store.setState()` that writes the session. First tick sees `session === null` and terminates the loop.
5. **`stopRide()` persists before store update** — `saveLastSession()` at line 100 fires before store.setState at line 125. If it throws, ride stays `isActive: true` in memory.
6. **`stopRide()` mutates `completedSession` in place** — `session.activityId = activity.id` at line 369 mutates the caller's object, which bleeds into store update.
7. **`defaultRouteSegments` data bug** — Lines 18-21 in `src/app/store/initial-state.js`: labels say "缓降" (gentle descent) but `gradePercent` values are positive (climb).

## Medium Risk

8. **SQLite string interpolation instead of parameterized queries** — `src/server/activity-store.js` uses homegrown `sqlValue()` rather than `db.prepare(sql).all(...)` with bound parameters.
9. **No file upload size limits** — multer configured with just `memoryStorage()` in `src/server/index.js`, no `limits` set.
10. **Token-store read-all/write-all race** — `src/server/token-store.js` pattern is not atomic; two concurrent `set()` calls can lose data.
11. **`canStart` true when `externalPowerConnected: true` but `activePowerSource: "none"`** — `src/app/services/device-service.js:415` enables start button without live power data.
12. **No `beforeunload` handler** — Active ride data and BLE connections lost on page close/refresh (`src/app/bootstrap.js`).
13. **FIT SDK loaded from external CDN without SRI** — `src/adapters/fit/fit-sdk-loader.js` loads from esm.sh/jsdelivr with no integrity hash.
14. **No timeout on Strava HTTP requests** — `src/server/strava-client.js` fetch calls may hang indefinitely.
15. **OAuth state Map unbounded growth** — `src/server/routes/strava-routes.js` entries have 10-min TTL but no eviction sweep; call volume can exhaust memory.
16. **Immersive street view exit non-persistent** — `src/ui/renderers/dashboard-renderer.js:262` exits via back button are reverted on next `render()` call.

## Low Risk / Code Quality

17. `escapeHtml` duplicated across 6 renderer files
18. `downsamplePoints` duplicated in `activity-detail-renderer.js` and `ride-series-chart.js`
19. `calculateIntensityFactor`, `calculateVariabilityIndex`, etc. duplicated between `ride-metrics.js` and `live-ride-session.js`
20. `main-view.js` factory has 60+ parameters — tight coupling
21. Records array copied on every tick in `live-ride-session.js` — O(n) per tick for 10800+ records in a 3h ride
22. No `destroy()` on BLE adapters — connections leak on service replacement
23. `buildColoredSegments` creates one `<line>` per route point — DOM bloat on long routes
24. Mixed Chinese/English localization — `export-service.js` status text in English, rest in Chinese
25. `resolveSpeedTarget` binary search upper bound (35 m/s) inconsistent with `simulateStep` speed limit (33.3 m/s)
26. Air density hardcoded at sea-level standard — 10-20% error on high-altitude routes
27. `estimateHeartRate` never called during active rides — no HR estimation without sensor
28. Initial map view hardcoded to Shanghai `[31.2304, 121.4737]`
29. 28-line SELECT column list duplicated in 3 methods in `activity-store.js`

**Why:** Full codebase audit conducted on 2026-05-14. All 134 tests pass.
**How to apply:** Review before starting major work. Fix critical items (#4, #5, #7) as first priority. Address security (#1, #2, #3) before any public deployment.
