# CLAUDE.md

This file provides guidance when working in this repository.

## Overview

Personal FIT Agent is a local sports data assistant: download Garmin China FIT files, generate activity reports via an LLM, maintain a SQLite activity catalogue, and optionally upload to Strava. The LLM backend uses an Anthropic Messages API-compatible endpoint from `config.yaml`.

## Commands

```bash
pip install -r requirements.txt
python -m pytest

python -m app.cli chat
python -m app.cli chat "分析最新的活动"
python -m app.cli analyze-file latest --force
python -m app.cli sync-garmin --count 5
python -m app.cli upload-strava ACTIVITY_KEY

python -m app.debug_cli list-activities --limit 10
python -m app.debug_cli inspect-fit latest
python -m app.debug_cli storage-status
```

## Architecture

The main path is native tool use:

```text
User message -> main_agent loop with only activate_skill -> Skill Guard/loader -> next model round with one Skill tool whitelist -> TOOL_HANDLERS[name] -> direct local handler -> tool_result
```

There is no planner stack or separate selector request. The main model initially sees only Skill names, descriptions, and `activate_skill`; activation loads one Skill and exposes only its immutable tool allowlist on the next model round. Local runtime checks both the active Skill and every tool call, while existing services and workflows keep their deterministic behavior.

Key boundaries:

- `agent/main_agent/`: tool-use loop, context, guard and dispatch.
- `agent/analysis/`: focused FIT child agent, prompts and persisted navigation workspace.
- `agent/skills/`: project Skill catalogue, immutable tool allowlists, loader and Skill library.
- `agent/tools/`: ToolDef contracts plus thin AgentContext adapters.
- `services/activity/`: context-free activity catalogue, analysis, comparison, history and report use cases.
- `fit/analysis/`: deterministic FIT metrics and time-series scanners.
- `storage/repositories/`: authoritative activity, analysis and workflow repositories.
- `integrations/`: Garmin, Strava and LLM clients.
- `operations/`: sync, upload, batch report and recoverable workflow orchestration.

Single FIT analysis is owned by `agent/analysis/agent.py`. It starts an independent `fit_analysis` child-agent session, exposes only read-only Tool contracts from `agent/tools/fit_analysis/`, and commits the current V2 report to SQLite. `tests/test_architecture.py` enforces that reusable services and infrastructure do not import the Agent layer.
