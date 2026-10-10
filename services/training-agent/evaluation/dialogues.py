"""Stateful, isolated Main Agent evaluation. Business outputs are explicit fixtures.

Run sequentially: the sandbox temporarily replaces the process tool registry.
This evaluates model/tool orchestration, not Providers or FIT calculations.
"""
from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
from collections import Counter
from copy import deepcopy
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from agent.main_agent.context import AgentContext
from agent.main_agent.loop import run_tool_loop
from agent.tools.registry import TOOL_HANDLERS
from agent.main_agent.tool_result import is_failed_tool_output
from evaluation.graders import grade_case
from evaluation.sandbox import EvaluationSandbox
from evaluation.schema import EvalCase
from integrations.llm import AnthropicMessagesClient
from observability import capture_agent_trace


def load_dialogues(paths):
    cases, ids, families, prompts = [], set(), {}, {}
    for path in paths:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("schema_version") != "agent_dialogue_case.v1":
                raise ValueError("unsupported dialogue schema")
            if row.get("split") not in {"validation", "test"}:
                raise ValueError("split must be validation or test")
            case_id, family = row.get("case_id"), row.get("scenario_family")
            if not case_id or not family or case_id in ids:
                raise ValueError("missing identity or duplicate case_id")
            ids.add(case_id)
            if family in families and families[family] != row["split"]:
                raise ValueError("scenario family leaks between splits")
            families[family] = row["split"]
            turns = row.get("turns")
            if not isinstance(turns, list) or not turns:
                raise ValueError("nonempty turns required")
            for turn in turns:
                case = EvalCase.from_dict({"case_id": case_id, "mode": "live", **turn})
                completion = case.expected.get("completion")
                if not isinstance(completion, dict) or not completion.get("result_status"):
                    raise ValueError("each turn needs an expected result status")
                key = "".join(case.input.split()).lower()
                if key in prompts and prompts[key] != row["split"]:
                    raise ValueError("identical prompt leaks between splits")
                prompts[key] = row["split"]
                for name, value in case.tool_outputs.items():
                    if name not in TOOL_HANDLERS or name == "activate_skill":
                        raise ValueError(f"invalid fixture tool: {name}")
                    outputs = value if isinstance(value, list) else [value]
                    if not outputs or not all(isinstance(x, dict) for x in outputs):
                        raise ValueError("fixture outputs must be objects")
            cases.append(row)
    if not cases:
        raise ValueError("no dialogue cases")
    return cases


def run_dialogue(case, *, client=None):
    # Instantiate before isolation so the configured model can be used, without
    # exporting credentials to traces or changing the user's configuration.
    client = client or AnthropicMessagesClient()
    context = AgentContext(session_id=f"eval-{case['case_id']}", history_enabled=False)
    results = []
    started_at = datetime.now(timezone.utc).isoformat()
    with TemporaryDirectory(prefix="rider-dialogue-") as tmp:
        root = Path(tmp)
        env = {"RIDER_PROJECT_ROOT": tmp, "RIDER_DATA_ROOT": str(root / "data"),
               "RIDER_TRACKER_DB_PATH": str(root / "data/rider.db"),
               "TRAINING_AGENT_DB_PATH": str(root / "data/rider.db")}
        with patch.dict(os.environ, env), patch(
            "agent.main_agent.loop.AnthropicMessagesClient", return_value=client
        ):
            for index, turn in enumerate(case["turns"], 1):
                eval_case = EvalCase.from_dict({"case_id": case["case_id"], "mode": "live", **turn})
                sandbox = EvaluationSandbox(eval_case)
                fixture_handlers = sandbox.handlers()
                calls, unsupported = [], []
                def wrap(name):
                    def handle(args, ctx):
                        if name not in eval_case.tool_outputs:
                            unsupported.append(name)
                            output = {"status": "failed", "error": "unconfigured_evaluation_tool",
                                      "message": f"No fixture for {name}", "retryable": False}
                        else:
                            output = fixture_handlers[name](args, ctx)
                            if name == "resolve_activities" and not is_failed_tool_output(output):
                                selected = ctx.selected_activities
                                ctx.current_activity_key = selected[0].get("activity_key") if len(selected) == 1 else None
                                if len(selected) != 1:
                                    ctx.current_fit_file = None
                        calls.append({"name": name, "arguments": deepcopy(args),
                                      "output": deepcopy(output), "success": not is_failed_tool_output(output)})
                        return output
                    return handle
                handlers = {name: wrap(name) for name in TOOL_HANDLERS if name != "activate_skill"}
                # Mutate the shared dictionary so deterministic retry/control paths
                # are sandboxed as well; restore every handler after this turn.
                with patch.dict(TOOL_HANDLERS, handlers), capture_agent_trace() as trace:
                    try:
                        result = run_tool_loop(eval_case.input, context=context, use_history=False)
                    except Exception as exc:
                        result = {"status": "failed", "answer": "", "error": {"type": type(exc).__name__}}
                trace_data = trace.to_dict()
                # Wrappers also observe calls from deterministic control turns.
                recorded = trace_data.setdefault("tool_calls", [])
                key = lambda c: (c.get("name"), json.dumps(c.get("arguments"), sort_keys=True))
                counts = Counter(key(c) for c in recorded)
                for entry in calls:
                    signature = key(entry)
                    if counts[signature]:
                        counts[signature] -= 1
                    else:
                        recorded.append(entry)
                result["skill_id"] = context.active_skill_id
                grade = grade_case(eval_case, result=result, trace=trace_data)
                selected = [a.get("activity_key") for a in context.selected_activities]
                expected_keys = turn.get("selected_activity_keys")
                if expected_keys is not None and selected != expected_keys:
                    grade["passed"] = False
                    grade["failures"].append(f"selected activities: expected {expected_keys}, got {selected}")
                if unsupported:
                    grade["passed"] = False
                    grade["failures"].append(f"unconfigured tools: {unsupported}")
                results.append({"turn": index, "input": eval_case.input,
                                "result": {k: result.get(k) for k in ("status", "answer", "skill_id", "error")},
                                "selected_activity_keys": selected, "trace": trace_data, "grade": grade})
    return {"schema_version": "agent_dialogue_result.v1", "case_id": case["case_id"],
            "case_sha256": hashlib.sha256(json.dumps(case, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            "case": deepcopy(case), "started_at": started_at, "model": getattr(client, "model", None),
            "split": case["split"], "scope": "real_main_agent_with_fixture_business_tools",
            "passed": all(t["grade"]["passed"] for t in results), "turns": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--check", action="store_true", help="validate both splits without model calls")
    parser.add_argument("--split", choices=["validation", "test"])
    parser.add_argument("--case-id", action="append")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    cases = load_dialogues(args.paths)
    if args.check:
        print(json.dumps({"cases": len(cases), "single_turn": sum(len(c["turns"]) == 1 for c in cases),
                          "multi_turn": sum(len(c["turns"]) > 1 for c in cases)}, ensure_ascii=False))
        return 0
    if not args.output:
        parser.error("--output is required for live model execution")
    selected = [c for c in cases if (not args.split or c["split"] == args.split)
                and (not args.case_id or c["case_id"] in args.case_id)]
    if not selected:
        parser.error("no cases selected")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    failed = False
    with args.output.open("x", encoding="utf-8") as output:
        for case in selected:
            result = run_dialogue(case)
            failed = failed or not result["passed"]
            output.write(json.dumps(result, ensure_ascii=False, default=str) + "\n")
            output.flush()
            print(f"{result['case_id']}: {'PASS' if result['passed'] else 'FAIL'}", flush=True)

    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
