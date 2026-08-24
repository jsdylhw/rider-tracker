"""Deterministic short cycling-sprint detection for the FIT tool layer."""

from __future__ import annotations

from typing import Any

from fit.analysis.stats import _round_float, prune_empty_values
from fit.parser import records_dataframe


def detect_sprints(parsed: dict[str, Any], *, max_segments: int = 12) -> dict[str, Any]:
    """Detect 3-45 second cycling power bursts from recorded samples.

    The threshold combines non-zero P90 with 120% of the FIT FTP when present.
    This locates candidate segments; physiological interpretation remains the
    Activity Agent's responsibility.
    """
    df = records_dataframe(parsed.get("records") or [])
    if df.empty or "elapsed_s" not in df.columns or "power" not in df.columns:
        return _unavailable("Power and elapsed-time records are required.")
    columns = [
        column for column in
        ("elapsed_s", "power", "heart_rate", "cadence", "enhanced_speed", "speed")
        if column in df.columns
    ]
    working = df[columns].copy()
    working["power"] = _numeric(working["power"])
    working = working.dropna(subset=["elapsed_s", "power"])
    nonzero = working.loc[working["power"] > 0, "power"]
    if len(nonzero) < 5:
        return _unavailable("Not enough non-zero power samples.")

    ftp = _ftp(parsed)
    p90 = float(nonzero.quantile(0.90))
    threshold = max(p90, ftp * 1.20 if ftp else 0)
    active = working[working["power"] >= threshold]
    groups = _contiguous_groups(working, active)
    candidates = [
        value for group in groups
        if (value := _candidate(group, working, threshold=threshold, ftp=ftp)) is not None
    ]
    candidates = sorted(candidates, key=lambda item: float(item.get("start_s") or 0))
    return {
        "schema_version": "sprint_detection.v1",
        "available": True,
        "detector": "cycling_power_sprint_v1",
        "settings": {
            "minimum_duration_s": 3,
            "maximum_duration_s": 45,
            "threshold_power_w": _round_float(threshold, 1),
            "ftp_w": _round_float(ftp, 1),
            "nonzero_power_p90_w": _round_float(p90, 1),
        },
        "count": min(len(candidates), max(1, int(max_segments))),
        "segments": candidates[:max(1, int(max_segments))],
    }


def _contiguous_groups(working: Any, active: Any) -> list[Any]:
    groups: list[Any] = []
    indices: list[Any] = []
    previous: float | None = None
    for index, row in active.iterrows():
        elapsed = float(row["elapsed_s"])
        if previous is not None and elapsed - previous > 2.5:
            if indices:
                groups.append(working.loc[indices])
            indices = []
        indices.append(index)
        previous = elapsed
    if indices:
        groups.append(working.loc[indices])
    return groups


def _candidate(group: Any, working: Any, *, threshold: float, ftp: float | None) -> dict[str, Any] | None:
    start = float(group["elapsed_s"].min())
    end = float(group["elapsed_s"].max())
    duration = max(1.0, end - start + 1.0)
    if duration < 3 or duration > 45:
        return None
    window = working[(working["elapsed_s"] >= start) & (working["elapsed_s"] <= end)]
    average_power = _mean(window, "power")
    peak_power = _max(window, "power")
    if average_power is None or peak_power is None:
        return None
    speed_column = _speed_column(window)
    return prune_empty_values({
        "type": "sprint",
        "start_s": _round_float(start, 1),
        "end_s": _round_float(end, 1),
        "duration_s": _round_float(duration, 1),
        "avg_power_w": _round_float(average_power, 1),
        "max_power_w": _round_float(peak_power, 1),
        "power_to_ftp": _round_float(average_power / ftp, 3) if ftp else None,
        "avg_hr_bpm": _round_float(_mean(window, "heart_rate"), 1),
        "max_hr_bpm": _round_float(_max(window, "heart_rate"), 1),
        "avg_cadence_rpm": _round_float(_mean(window, "cadence"), 1),
        "avg_speed_kmh": _round_float(_mean(window, speed_column) * 3.6, 1) if speed_column else None,
        "score": _round_float(min(peak_power / threshold, 2.0) / 2.0, 3),
    })


def _ftp(parsed: dict[str, Any]) -> float | None:
    metadata = parsed.get("training_metadata") if isinstance(parsed.get("training_metadata"), dict) else {}
    zones = metadata.get("zones_target") if isinstance(metadata.get("zones_target"), dict) else {}
    sessions = parsed.get("sessions") if isinstance(parsed.get("sessions"), list) else []
    session = sessions[-1] if sessions and isinstance(sessions[-1], dict) else {}
    for value in (zones.get("functional_threshold_power"), session.get("threshold_power")):
        try:
            if value is not None and float(value) > 0:
                return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _numeric(series: Any) -> Any:
    import pandas as pd

    return pd.to_numeric(series, errors="coerce")


def _mean(df: Any, column: str | None) -> float | None:
    if not column or column not in df.columns:
        return None
    values = _numeric(df[column]).dropna()
    return float(values.mean()) if not values.empty else None


def _max(df: Any, column: str) -> float | None:
    if column not in df.columns:
        return None
    values = _numeric(df[column]).dropna()
    return float(values.max()) if not values.empty else None


def _speed_column(df: Any) -> str | None:
    if "enhanced_speed" in df.columns:
        return "enhanced_speed"
    return "speed" if "speed" in df.columns else None


def _unavailable(reason: str) -> dict[str, Any]:
    return {
        "schema_version": "sprint_detection.v1",
        "available": False,
        "reason": reason,
        "count": 0,
        "segments": [],
    }
