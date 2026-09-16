# CLAUDE.md

This file provides guidance when working in this repository.

## Overview

This directory is Rider Tracker's embedded Python Training Backend, not a second standalone product or browser UI. It owns activity and route persistence, FIT analysis, Agent/Skill execution, external-provider workflows, HTTP APIs and selected durable jobs. The repository root `config.yaml` is the only manual configuration source.

Before changing cross-process behavior, read the root `AGENTS.md`, `docs/README.md` and
`docs/development-guide.md`. The frozen target architecture is documented separately; completed migration work and current
implementation decisions belong in the ADR.

## Commands

```bash
pip install -r requirements.txt
python -m pytest

# Run these from the Rider repository root so config and database paths stay unified.
npm run agent:cli -- chat
npm run agent:cli -- chat "分析最新的活动"
npm run agent:cli -- analyze-file latest --force
npm run agent:cli -- sync-garmin --count 5
npm run agent:cli -- upload-strava ACTIVITY_KEY

npm run agent:cli -- debug list-activities --limit 10
npm run agent:cli -- debug inspect-fit latest
npm run agent:cli -- debug storage-status
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
