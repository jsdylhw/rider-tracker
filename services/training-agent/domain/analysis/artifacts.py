"""Accessors for the only persisted report contract: Summary V2."""

from __future__ import annotations

from typing import Any

from domain.contracts.schemas import ACTIVITY_REPORT_V2


# 保留旧常量名供现有报告代码使用；实际版本值由稳定契约注册表统一定义。
SUMMARY_SCHEMA_V2 = ACTIVITY_REPORT_V2
ANALYSIS_SUMMARY_SCHEMA_V1 = "activity_analysis_summary.v1"


def summary_schema_version(document: dict[str, Any]) -> str:
    value = str(document.get("schema_version") or "")
    return SUMMARY_SCHEMA_V2 if value == SUMMARY_SCHEMA_V2 else "unknown"


def get_index_load_label(entry: dict[str, Any]) -> Any:
    """Read the qualitative load label copied from the V2 analysis summary."""
    return entry.get("load_label")


def analysis_summary_from_submission(entry: dict[str, Any]) -> dict[str, Any]:
    """Normalize the child agent's qualitative submission for Summary V2."""
    return {
        "schema_version": ANALYSIS_SUMMARY_SCHEMA_V1,
        "summary_label": entry.get("summary_label"),
        "main_stimulus": entry.get("main_stimulus"),
        "load_label": entry.get("load_label"),
        "quality_notes": entry.get("quality_notes") if isinstance(entry.get("quality_notes"), list) else [],
        "brief": entry.get("brief") or "",
    }


def get_analysis_summary(document: dict[str, Any]) -> dict[str, Any]:
    value = document.get("analysis_summary")
    return value if isinstance(value, dict) else {}


def build_history_view(document: dict[str, Any]) -> dict[str, Any]:
    """Derive a compact history view from a V2 report without extra storage."""
    analysis = get_analysis_summary(document)
    fit_summary = document.get("fit_summary") if isinstance(document.get("fit_summary"), dict) else {}
    duration_s = _number(fit_summary.get("duration_s"))
    distance_m = _number(fit_summary.get("distance_m"))
    return {
        "kind": "activity_report_history",
        "activity_key": document.get("activity_key"),
        "file_path": document.get("fit_path"),
        "start_time": fit_summary.get("start_time_local"),
        "start_time_local": fit_summary.get("start_time_local"),
        "sport_type": fit_summary.get("sport_type"),
        "sub_sport": fit_summary.get("sub_sport"),
        "duration_s": duration_s,
        "distance_m": distance_m,
        "duration_min": round(duration_s / 60, 2) if duration_s is not None else None,
        "distance_km": round(distance_m / 1000, 3) if distance_m is not None else None,
        "summary_label": analysis.get("summary_label"),
        "main_stimulus": analysis.get("main_stimulus"),
        "load_label": analysis.get("load_label"),
        "quality_notes": analysis.get("quality_notes") if isinstance(analysis.get("quality_notes"), list) else [],
        "brief": analysis.get("brief") or "",
    }


def get_tss(metrics: dict[str, Any]) -> float | None:
    """Return TSS from activity_metrics.v2."""
    load = metrics.get("load") if isinstance(metrics.get("load"), dict) else {}
    power_stress = load.get("power_stress") if isinstance(load.get("power_stress"), dict) else {}
    return _number(power_stress.get("tss"))


def get_tss_source(metrics: dict[str, Any]) -> str:
    load = metrics.get("load") if isinstance(metrics.get("load"), dict) else {}
    power_stress = load.get("power_stress") if isinstance(load.get("power_stress"), dict) else {}
    return str(power_stress.get("source") or "unavailable")


def _number(*values: Any) -> float | None:
    for value in values:
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None
