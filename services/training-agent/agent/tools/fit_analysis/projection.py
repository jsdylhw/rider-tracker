"""Compact model-facing interval projection; numerical ownership stays in FIT tools."""
from __future__ import annotations

from typing import Any

_METRIC_SUFFIXES = {
    "power": ("power_w",), "heart_rate": ("hr_bpm",),
    "cadence": ("cadence_rpm", "cadence_spm"),
    "speed": ("speed_mps", "pace_s_per_km"), "altitude": ("altitude_m",),
}


def project_intervals(result: dict[str, Any], *, view: str = "intervals", metrics: list[str] | None = None) -> dict[str, Any]:
    if view not in {"summary", "intervals"}:
        raise ValueError("view must be summary or intervals")
    if metrics is not None and (
        not isinstance(metrics, list) or not metrics
        or any(not isinstance(metric, str) or metric not in _METRIC_SUFFIXES for metric in metrics)
    ):
        raise ValueError("metrics must be a nonempty list of supported metric names")
    if not result.get("available"):
        return result
    selected = list(_METRIC_SUFFIXES) if metrics is None else metrics
    output = {k: v for k, v in result.items() if k not in {"series", "format", "window_summary"}}
    summary = result["window_summary"]
    output["window_summary"] = {**summary, "metrics": {
        k: v for k, v in summary["metrics"].items() if k in selected
    }}
    output["view"] = view
    if view == "summary":
        return output
    series = result["series"]
    common = {"start_s", "end_s", "start_d", "end_d", "duration_s", "samples"}
    suffixes = tuple(suffix for metric in selected for suffix in _METRIC_SUFFIXES[metric])
    columns = [key for key in series if key in common or any(
        key.endswith(suffix) or key.startswith(suffix + "_") for suffix in suffixes
    )]
    output.update(format="table", columns=columns,
                  rows=[list(row) for row in zip(*(series[key] for key in columns))])
    return output
