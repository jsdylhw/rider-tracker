"""Build compact UI-only series from local activity records after LLM execution."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fit.parser import parse_fit, records_dataframe


DEFAULT_PROFILE_POINTS = 300


def build_activity_profile(
    fit_path: Any,
    *,
    max_points: int = DEFAULT_PROFILE_POINTS,
) -> dict[str, Any]:
    """Return downsampled activity series without adding them to the LLM prompt."""
    path = Path(str(fit_path or "")).expanduser()
    if path.suffix.lower() != ".fit" or not path.is_file():
        return {}
    try:
        parsed = parse_fit(path)
        return activity_profile_from_records(parsed.get("records") or [], max_points=max_points)
    except Exception:
        # Presentation is optional and must never turn a completed analysis into a failed turn.
        return {}


def activity_profile_from_records(
    records: list[dict[str, Any]],
    *,
    max_points: int = DEFAULT_PROFILE_POINTS,
) -> dict[str, Any]:
    """Project timestamped FIT records into elapsed-time sensor series."""
    if max_points < 2:
        raise ValueError("max_points must be at least 2")
    frame = records_dataframe(records)
    if frame.empty or "elapsed_s" not in frame.columns:
        return {}
    specifications = [
        ("distance", "cumulative_distance_km", "km", 0.001, 3),
        ("heart_rate", "heart_rate_bpm", "bpm", 1.0, 1),
        ("power", "power_w", "W", 1.0, 1),
    ]
    available = [column for column, *_ in specifications if column in frame.columns and frame[column].notna().any()]
    if not available:
        return {}
    usable = frame[["elapsed_s", *available]].dropna(subset=["elapsed_s"])
    if usable.empty:
        return {}
    rows = [
        row for row in usable.to_dict(orient="records")
        if _number(row.get("elapsed_s")) is not None and float(row["elapsed_s"]) >= 0
    ]
    if not rows:
        return {}
    sampled = _aggregate_rows(rows, max_points=max_points, metric_columns=available)
    series = []
    for column, metric, unit, scale, digits in specifications:
        if column not in available:
            continue
        values = [_scaled_number(row.get(column), scale=scale, digits=digits) for row in sampled]
        if any(value is not None for value in values):
            series.append({"metric": metric, "unit": unit, "values": values})
    return {
        "x_label": "经过时间",
        "labels": [_elapsed_label(float(row["elapsed_s"])) for row in sampled],
        "series": series,
    }


def _aggregate_rows(
    rows: list[dict[str, Any]],
    *,
    max_points: int,
    metric_columns: list[str],
) -> list[dict[str, Any]]:
    if len(rows) <= max_points:
        return rows
    interior = rows[1:-1]
    bin_count = max_points - 2
    aggregated = [rows[0]]
    for position in range(bin_count):
        start = round(position * len(interior) / bin_count)
        end = round((position + 1) * len(interior) / bin_count)
        chunk = interior[start:end]
        if chunk:
            aggregated.append(_aggregate_chunk(chunk, metric_columns=metric_columns))
    aggregated.append(rows[-1])
    return aggregated


def _aggregate_chunk(rows: list[dict[str, Any]], *, metric_columns: list[str]) -> dict[str, Any]:
    elapsed = [_number(row.get("elapsed_s")) for row in rows]
    result: dict[str, Any] = {
        "elapsed_s": sum(value for value in elapsed if value is not None) / sum(value is not None for value in elapsed),
    }
    for column in metric_columns:
        values = [_number(row.get(column)) for row in rows]
        numeric = [value for value in values if value is not None]
        if not numeric:
            result[column] = None
        elif column == "distance":
            result[column] = numeric[-1]
        else:
            result[column] = sum(numeric) / len(numeric)
    return result


def _scaled_number(value: Any, *, scale: float, digits: int) -> float | None:
    number = _number(value)
    if number is None:
        return None
    return round(number * scale, digits)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def _elapsed_label(elapsed_s: float) -> str:
    total_seconds = max(0, int(round(elapsed_s)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"
