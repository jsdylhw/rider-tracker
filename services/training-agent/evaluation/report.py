"""Persist machine-readable evaluation artifacts and a concise Markdown report."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any

from project_paths import runtime_paths


def write_report(results: list[dict[str, Any]], *, output_dir: str | Path) -> dict[str, Any]:
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    summary = summarize_results(results)
    results_path = target / "results.jsonl"
    with results_path.open("w", encoding="utf-8") as handle:
        for result in results:
            handle.write(json.dumps(result, ensure_ascii=False, default=str) + "\n")
    summary_path = target / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    report_path = target / "report.md"
    report_path.write_text(_markdown_report(summary, results), encoding="utf-8")
    return {
        "output_dir": str(target),
        "results_path": str(results_path),
        "summary_path": str(summary_path),
        "report_path": str(report_path),
        "summary": summary,
    }


def summarize_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    grades = [result.get("grade") or {} for result in results]
    metric_names = (
        "intent_accuracy", "skill_selection", "tool_selection", "task_completion", "answer_consistency",
    )
    metrics: dict[str, float | None] = {}
    metric_coverage: dict[str, int] = {}
    for name in metric_names:
        values = [grade.get("scores", {}).get(name) for grade in grades]
        numeric = [float(value) for value in values if value is not None]
        metrics[name] = round(mean(numeric), 4) if numeric else None
        metric_coverage[name] = len(numeric)
    latencies = sorted(float(grade.get("latency_ms") or 0) for grade in grades)
    usage = {
        key: sum(int(grade.get("usage", {}).get(key) or 0) for grade in grades)
        for key in (
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
            "total_tokens",
        )
    }
    costs = [grade.get("estimated_cost_usd") for grade in grades if grade.get("estimated_cost_usd") is not None]
    passed = sum(1 for grade in grades if grade.get("passed"))
    return {
        "schema_version": "agent_eval_summary.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "case_runs": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "pass_rate": round(passed / len(results), 4) if results else 0.0,
        "metrics": metrics,
        "metric_coverage": metric_coverage,
        "latency_ms": {
            "average": round(mean(latencies), 3) if latencies else None,
            "p50": _percentile(latencies, 0.50),
            "p95": _percentile(latencies, 0.95),
        },
        "usage": usage,
        "estimated_cost_usd": round(sum(float(value) for value in costs), 8) if costs else None,
    }


def default_run_directory(root: str | Path | None = None) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = Path(root) if root is not None else runtime_paths().evaluation_artifact_dir
    return target / stamp


def _percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    index = (len(values) - 1) * quantile
    lower = int(index)
    upper = min(lower + 1, len(values) - 1)
    fraction = index - lower
    return round(values[lower] * (1 - fraction) + values[upper] * fraction, 3)


def _markdown_report(summary: dict[str, Any], results: list[dict[str, Any]]) -> str:
    metrics = summary["metrics"]
    coverage = summary["metric_coverage"]
    latency = summary["latency_ms"]
    lines = [
        "# Personal FIT Agent Evaluation",
        "",
        f"- Case runs: **{summary['case_runs']}**",
        f"- Passed: **{summary['passed']}**",
        f"- Failed: **{summary['failed']}**",
        f"- Pass rate: **{summary['pass_rate']:.1%}**",
        "",
        "## Metrics",
        "",
        "| Metric | Score |",
        "|---|---:|",
    ]
    for name, value in metrics.items():
        lines.append(f"| {name} | {_score(value)} ({coverage[name]}/{summary['case_runs']}) |")
    lines.extend([
        "",
        "## Performance",
        "",
        f"- Average latency: `{latency['average']} ms`",
        f"- P50 latency: `{latency['p50']} ms`",
        f"- P95 latency: `{latency['p95']} ms`",
        f"- Input tokens: `{summary['usage']['input_tokens']}`",
        f"- Output tokens: `{summary['usage']['output_tokens']}`",
        f"- Cache-write tokens: `{summary['usage']['cache_creation_input_tokens']}`",
        f"- Cache-read tokens: `{summary['usage']['cache_read_input_tokens']}`",
        f"- Total processed tokens: `{summary['usage']['total_tokens']}`",
        f"- Estimated cost: `{summary['estimated_cost_usd'] if summary['estimated_cost_usd'] is not None else 'not configured'}`",
        "",
        "## Failures",
        "",
    ])
    failed = [result for result in results if not result.get("grade", {}).get("passed")]
    if not failed:
        lines.append("No failures.")
    for result in failed:
        case_id = result.get("case", {}).get("case_id")
        lines.append(f"### {case_id}")
        lines.append("")
        for failure in result.get("grade", {}).get("failures") or ["unknown failure"]:
            lines.append(f"- {failure}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _score(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1%}"
