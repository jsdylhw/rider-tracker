from __future__ import annotations

import json
from pathlib import Path

from evaluation.graders import grade_case
from evaluation.report import summarize_results, write_report
from evaluation.runner import run_case, run_suite
from evaluation.schema import EvalCase, EvalCaseError, load_cases


def test_load_cases_rejects_duplicate_ids(tmp_path):
    path = tmp_path / "cases.jsonl"
    row = {"case_id": "same", "input": "你好", "mode": "skill", "expected": {"intent": "chat"}}
    path.write_text(json.dumps(row, ensure_ascii=False) + "\n" + json.dumps(row, ensure_ascii=False), encoding="utf-8")

    try:
        load_cases(path)
    except EvalCaseError as exc:
        assert "duplicate case_id" in str(exc)
    else:
        raise AssertionError("duplicate IDs must be rejected")


def test_skill_grader_reports_match_and_mismatch():
    class FakeClient:
        def create_messages(self, **kwargs):
            return {
                "content": [{"type": "text", "text": "你好。"}],
                "stop_reason": "end_turn",
            }

    matching = EvalCase.from_dict({
        "case_id": "chat-match", "input": "你好", "mode": "skill",
        "expected": {"skill_id": None, "intent": "chat"},
    })
    results = run_suite([matching], mode="skill", client_factory=FakeClient)
    assert results[0]["grade"]["passed"] is True
    mismatch = run_case(EvalCase.from_dict({
        "case_id": "synthetic-mismatch",
        "input": "你好",
        "mode": "skill",
        "expected": {"intent": "upload"},
    }), client=FakeClient())
    assert mismatch["grade"]["passed"] is False
    assert "intent expected" in mismatch["grade"]["failures"][0]


def test_skill_evaluation_uses_real_activate_skill_protocol():
    case = EvalCase.from_dict({
        "case_id": "activation-protocol",
        "input": "分析最近一次骑行",
        "mode": "skill",
        "expected": {"skill_id": "analyze-activity", "intent": "analyze_single"},
    })

    class FakeClient:
        def create_messages(self, **kwargs):
            self.kwargs = kwargs
            return {
                "content": [{
                    "type": "tool_use", "id": "tu-activate", "name": "activate_skill",
                    "input": {"skill_id": "analyze-activity"},
                }],
                "stop_reason": "tool_use",
            }

    client = FakeClient()
    result = run_case(case, client=client)

    assert result["grade"]["passed"] is True
    assert [tool["name"] for tool in client.kwargs["tools"]] == ["activate_skill"]
    assert "input_schema" not in client.kwargs["system"]
    assert result["result"]["steps"] == []


def test_tool_grader_supports_argument_constraints_and_completion():
    case = EvalCase.from_dict({
        "case_id": "tool-grade",
        "input": "sync",
        "mode": "live",
        "expected": {
            "required_tools": [{
                "name": "sync_and_run_activity_workflow",
                "arguments": {"count": 3, "goals": {"contains": "upload_strava"}},
            }],
            "forbidden_tools": ["run_activity_workflow"],
            "completion": {
                "result_status": "completed",
                "tool_results": [{
                    "name": "sync_and_run_activity_workflow", "path": "status", "equals": "completed",
                }],
            },
        },
    })
    trace = {
        "elapsed_ms": 12,
        "usage": {"input_tokens": 100, "output_tokens": 20},
        "tool_calls": [{
            "name": "sync_and_run_activity_workflow",
            "arguments": {"count": 3, "goals": ["ensure_summary", "upload_strava"]},
            "output": {"status": "completed"},
            "success": True,
        }],
    }

    grade = grade_case(
        case,
        result={"status": "completed", "intent": "mixed", "answer": "done"},
        trace=trace,
        input_price_per_million=1.0,
        output_price_per_million=2.0,
        cache_write_price_per_million=1.0,
        cache_read_price_per_million=0.1,
    )

    assert grade["passed"] is True
    assert grade["scores"]["tool_selection"] == 1.0
    assert grade["scores"]["task_completion"] == 1.0
    assert grade["estimated_cost_usd"] == 0.00014


def test_live_runner_uses_sandbox_and_captures_tool_trace():
    case = EvalCase.from_dict({
        "case_id": "safe-live",
        "input": "同步最近三个活动",
        "mode": "live",
        "expected": {
            "intent": "sync",
            "required_tools": [{"name": "sync_garmin_activities", "arguments": {"count": 3}}],
            "completion": {"result_status": "completed"},
        },
    })

    class FakeClient:
        def __init__(self):
            self.responses = iter([
                {
                    "content": [{
                        "type": "tool_use", "id": "tu-activate", "name": "activate_skill",
                        "input": {"skill_id": "sync-garmin-activities"},
                    }],
                    "stop_reason": "tool_use",
                },
                {
                    "content": [{
                        "type": "tool_use", "id": "tu-sync", "name": "sync_garmin_activities", "input": {"count": 3},
                    }],
                    "stop_reason": "tool_use",
                },
                {"content": [{"type": "text", "text": "同步完成"}], "stop_reason": "end_turn"},
            ])

        def create_message(self, **kwargs):
            return {
                "content": [{
                    "type": "text",
                    "text": '{"skill_id":"sync-garmin-activities","confidence":0.99,"reason":"pure sync"}',
                }],
                "stop_reason": "end_turn",
            }

        def create_messages(self, **kwargs):
            return next(self.responses)

    result = run_case(case, client=FakeClient())

    assert result["grade"]["passed"] is True
    call = next(
        item for item in result["trace"]["tool_calls"]
        if item["name"] == "sync_garmin_activities"
    )
    assert call["name"] == "sync_garmin_activities"
    assert call["output"]["downloaded"] == 2


def test_report_writes_jsonl_summary_and_markdown(tmp_path):
    case = EvalCase.from_dict({
        "case_id": "report-skill", "input": "你好", "mode": "skill",
        "expected": {"skill_id": None, "intent": "chat"},
    })

    class FakeClient:
        def create_messages(self, **kwargs):
            return {
                "content": [{"type": "text", "text": "你好。"}],
                "stop_reason": "end_turn",
            }

    results = [run_case(case, client=FakeClient())]

    artifact = write_report(results, output_dir=tmp_path / "report")

    assert artifact["summary"]["case_runs"] == 1
    assert artifact["summary"]["metric_coverage"]["intent_accuracy"] == 1
    assert (tmp_path / "report" / "results.jsonl").exists()
    assert (tmp_path / "report" / "summary.json").exists()
    report = (tmp_path / "report" / "report.md").read_text(encoding="utf-8")
    assert "Tool selection" not in report  # metric names stay machine-stable
    assert "intent_accuracy" in report
    assert summarize_results(results)["pass_rate"] == 1.0


def test_skill_cases_are_versioned_evaluation_inputs():
    cases = load_cases(Path(__file__).resolve().parents[1] / "evaluation" / "cases" / "skills.jsonl")

    assert len(cases) == 17
    assert all(case.mode == "skill" for case in cases)
    assert {case.expected.get("skill_id") for case in cases} >= {
        None, "analyze-activity", "run-activity-workflow", "sync-garmin-activities",
        "plan-routes",
    }
