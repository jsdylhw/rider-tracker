"""CLI for running Personal FIT Agent evaluations."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import typer

from evaluation.report import default_run_directory, write_report
from evaluation.runner import run_suite
from evaluation.schema import load_cases


app = typer.Typer(help="Run quantitative Personal FIT Agent evaluations.")
DEFAULT_CASES = Path(__file__).parent / "cases" / "skills.jsonl"


@app.command("run")
def run_command(
    cases: Path = typer.Option(DEFAULT_CASES, exists=True, dir_okay=False, help="JSONL case file."),
    mode: str = typer.Option("all", help="all, skill, or live."),
    repeats: int = typer.Option(1, min=1, help="Repeat each selected case."),
    output: Optional[Path] = typer.Option(None, help="Artifact directory."),
    input_price: Optional[float] = typer.Option(None, help="USD per million input tokens."),
    output_price: Optional[float] = typer.Option(None, help="USD per million output tokens."),
    cache_write_price: Optional[float] = typer.Option(None, help="USD per million cache-write tokens."),
    cache_read_price: Optional[float] = typer.Option(None, help="USD per million cache-read tokens."),
    fail_under: Optional[float] = typer.Option(None, min=0.0, max=1.0, help="Exit 1 below pass rate."),
) -> None:
    if mode not in {"all", "skill", "live"}:
        raise typer.BadParameter("mode must be all, skill, or live")
    results = run_suite(
        str(cases),
        mode=mode,
        repeats=repeats,
        input_price_per_million=input_price,
        output_price_per_million=output_price,
        cache_write_price_per_million=cache_write_price,
        cache_read_price_per_million=cache_read_price,
    )
    artifact = write_report(results, output_dir=output or default_run_directory())
    summary = artifact["summary"]
    typer.echo(f"cases={summary['case_runs']} pass_rate={summary['pass_rate']:.1%}")
    typer.echo(f"report={artifact['report_path']}")
    if fail_under is not None and summary["pass_rate"] < fail_under:
        raise typer.Exit(code=1)


@app.command("list-cases")
def list_cases_command(
    cases: Path = typer.Option(DEFAULT_CASES, exists=True, dir_okay=False),
) -> None:
    for case in load_cases(cases):
        typer.echo(f"{case.case_id}\t{case.mode}\t{','.join(case.tags)}\t{case.input}")


if __name__ == "__main__":
    app()
