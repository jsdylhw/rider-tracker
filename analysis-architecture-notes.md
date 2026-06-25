---
name: project-architecture-notes
description: "Architecture observations, design patterns, and code quality notes from 2026-05-14 audit"
metadata: 
  node_type: memory
  type: project
  originSessionId: c6b744bf-ae5b-446c-816b-c892c6b0e060
---

## Architecture Strengths

- **Clean layered architecture**: App → Domain → Adapters → UI → Server, with strict no-circular-dependency boundaries enforced by convention.
- **Domain layer is pure functions**: All cycling physics, physiology, route building are pure functions with no side effects — highly testable.
- **Custom state management**: Simple observable store (`app-store.js`) with `getState/setState/subscribe`. Single state tree. No framework dependency.
- **Comprehensive test coverage**: 134 tests across unit + integration, custom test harness, fake DOM in Node. All passing.
- **FIT file pipeline is well-designed**: Export → local save → optional Strava upload, with graceful degradation chains.
- **BLE architecture is solid**: Multi-phase trainer connection (data-ready → control-activating → control-ready), dual power source arbitration, EWMA signal stability tracking.
- **Street View controller is sophisticated**: Dual-panorama preloading, rate-limited position updates, user-interaction pause detection.
- **PiP (Picture-in-Picture) support**: Working implementation using `documentPictureInPicture` API with configurable chart/metric slots.

## Design Decisions to Know

- **No build step** — Browser loads vanilla JS modules directly from `src/`. No bundler, no TypeScript.
- **No CSS framework** — All hand-written CSS with `@import` modular organization from `src/styles/`.
- **Chinese-first UI** — User-facing strings are primarily Chinese. Some English mixing in `export-service.js`.
- **`window.setInterval` for physics loop** — Not `requestAnimationFrame`. Loop interval adapts based on power signal quality (250ms–1000ms).
- **FIT files are the source of truth for detail data** — SQLite stores summaries only; detail views re-parse FIT files.
- **Node 22+ `node:sqlite`** — Uses built-in SQLite with WAL mode, not better-sqlite3.

## Code Patterns to Follow

- **Factory functions with dependency injection**: Services and renderers are created by factory functions that receive their dependencies as parameters. Clean and testable.
- **`sanitize*` / `normalize*` naming**: Input validation functions follow consistent naming in `initial-state.js` and `http-utils.js`.
- **Signature-based change detection**: Some renderers compute a "signature" (stringified key fields) and skip re-render if unchanged. Pattern is used in `export-renderer.js`, `activity-detail-renderer.js`, `workout-renderer.js` but not everywhere.
- **`document.activeElement` guard**: Renderers that update form fields check `document.activeElement` to avoid cursor-jumping during live edits.
- **Escape HTML at render boundary**: SVG builders and HTML builders apply `escapeHtml` before inserting user/session data.

## Architecture Pain Points

- **`main-view.js` has 60+ constructor parameters** — the central orchestrator knows about everything.
- **Duplicated utilities across renderers**: `escapeHtml` (6 copies), `downsamplePoints` (2 copies), `numberOrNull` (5 copies), metrics calculation functions (2 copies between `ride-metrics.js` and `live-ride-session.js`).
- **Records array grows unbounded**: Each tick does `[...records, record]` — O(n) copy per tick. 3-hour ride = 10800 copies of growing arrays.
- **Stringly-typed DOM IDs**: Element IDs spread across view JS files and HTML templates with no shared constants.
- **No TypeScript or runtime type checking**: Property access everywhere is untyped; typos silently become `undefined`.

**Why:** Systematically recorded during full-stack codebase audit to guide future refactoring.
**How to apply:** Consult before architectural decisions. Follow existing patterns for new code. Reference pain points when scoping refactoring work.
