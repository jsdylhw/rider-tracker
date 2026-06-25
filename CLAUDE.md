# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the local dev server (defaults to http://127.0.0.1:8787)
npm start

# Run all tests (unit + integration)
npm test

# The server can be configured via env vars:
# PORT, HOST, STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, RIDER_TRACKER_DB_PATH
```

There is no build step — the browser loads vanilla JS modules directly from `src/`. The server serves `index.html` at `/`, `src/` as static files, and the Garmin FIT SDK from `node_modules/@garmin/fitsdk`.

## Architecture

This is a single-page virtual cycling application with a layered architecture. The browser loads `index.html` → `src/app/bootstrap.js` which wires everything together.

### Layer boundaries (strict, no circular dependencies)

| Layer | Dir | Role |
|---|---|---|
| **App** | `src/app/` | Orchestration: store, services, bootstrap, realtime engine |
| **Domain** | `src/domain/` | Pure logic: physics, physiology, route building, ride simulation, workout modes. No DOM, no network. |
| **Adapters** | `src/adapters/` | External boundaries: Web Bluetooth, FIT SDK, local storage APIs, Strava HTTP |
| **UI** | `src/ui/` | Rendering: views, renderers, map/street-view, PiP. Reads state, calls service callbacks. |
| **Server** | `src/server/` | Express backend: activity SQLite store, FIT file storage, Strava OAuth/upload |
| **Shared** | `src/shared/` | Formatting, metrics definitions, common util functions |

### State management

A simple custom store (`src/app/store/app-store.js`) with `getState() / setState(updater) / subscribe(listener)`. All state lives in one tree. Services are plain functions that receive `store` and mutate state via `setState`. State shape is defined in `src/app/store/initial-state.js` — key slices: `uiMode`, `route`, `settings`, `workout`, `session`, `liveRide`, `ble`, `exportMetadata`.

### Realtime ride loop

`src/app/services/ride-service.js` runs a `setInterval`-based physics loop. Each tick reads sensor samples (with staleness/throttling from `src/app/realtime/sensor-sampling.js`), advances the ride via `src/domain/ride/live-ride-session.js`, dispatches trainer commands, and updates the store. The loop adapts its interval based on whether a trainer is connected.

### Data flow for activities

1. Ride completes → session records + summary produced
2. FIT file exported and saved to `data/files/fit/` via server API
3. Activity summary (not full records) saved to SQLite (`data/rider-tracker.db`) with a `fit_file_path` pointer
4. Activity list page reads summaries from SQLite only
5. Activity detail page re-parses the FIT file to get full records for charts/analysis

### CSS organization

`src/style.css` uses `@import` to load modular stylesheets from `src/styles/` (base-layout, ride-dashboard, immersive-street-view, responsive, etc.). No CSS framework — all hand-written.

### Test infrastructure

Custom test harness in `tests/helpers/test-harness.js` with `assert`, `assertEqual`, `assertApprox`. Test files export a `suite` object with `{ name, tests: [{ name, fn }] }`. The runner (`tests/test-runner.js`) imports all suites and runs them. Tests run in Node with a fake DOM (`tests/helpers/fake-dom.js`) and DOMParser polyfill — no browser needed.

## Commit convention

Format: `type: summary` (English only). Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`. One purpose per commit. See `commit-convention.md` for details.
