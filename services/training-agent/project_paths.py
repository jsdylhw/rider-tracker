"""Process-independent project path helpers.

This module is deliberately free of storage or service dependencies so that
domain and FIT code can resolve persisted paths without crossing layer bounds.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


# The embedded backend lives at <rider>/services/training-agent. Falling back
# to this location keeps direct Python/CLI invocation independent from cwd.
DEFAULT_PROJECT_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class RuntimePaths:
    """All mutable Rider locations resolved independently from process cwd."""

    project_root: Path
    data_root: Path
    database: Path
    fit_root: Path
    garmin_fit_dir: Path
    credentials_dir: Path
    strava_token_store: Path
    workflow_dir: Path
    workflow_journal_dir: Path
    activity_workflow_dir: Path
    log_dir: Path
    cache_dir: Path
    evaluation_artifact_dir: Path
    migration_dir: Path
    legacy_athlete_file: Path


def project_root(*, base: Path | None = None) -> Path:
    """Return the path base shared by persisted Rider/Agent relative paths."""
    configured = os.environ.get("RIDER_PROJECT_ROOT")
    configured_root = Path(configured) if configured else None
    return (base or configured_root or DEFAULT_PROJECT_ROOT).expanduser().resolve()


def runtime_paths(
    *,
    base: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> RuntimePaths:
    """Build the canonical mutable-path contract.

    Explicit values may be absolute or project-relative.  Conflicting legacy
    database variables fail closed because silently selecting either database
    can split activities and route state across two files.
    """
    values = os.environ if environ is None else environ
    root = _root_from(values, base=base)
    data_root = _configured_path(values.get("RIDER_DATA_ROOT"), root / "data", root)
    rider_database = _optional_path(values.get("RIDER_TRACKER_DB_PATH"), root)
    agent_database = _optional_path(values.get("TRAINING_AGENT_DB_PATH"), root)
    if rider_database and agent_database and rider_database != agent_database:
        raise RuntimeError(
            "RIDER_TRACKER_DB_PATH and TRAINING_AGENT_DB_PATH must reference the same database"
        )
    database = rider_database or agent_database or data_root / "rider-tracker.db"
    fit_root = _configured_path(values.get("FIT_FILE_DIR"), data_root / "files" / "fit", root)
    credentials_dir = _configured_path(
        values.get("RIDER_CREDENTIALS_DIR"), data_root / "credentials", root,
    )
    workflow_dir = _configured_path(
        values.get("RIDER_WORKFLOW_DIR"), data_root / "workflows", root,
    )
    return RuntimePaths(
        project_root=root,
        data_root=data_root,
        database=database,
        fit_root=fit_root,
        garmin_fit_dir=_configured_path(
            values.get("GARMIN_FIT_DIR"), fit_root / "garmin", root,
        ),
        credentials_dir=credentials_dir,
        strava_token_store=_configured_path(
            values.get("STRAVA_TOKEN_STORE"), credentials_dir / "strava-tokens.json", root,
        ),
        workflow_dir=workflow_dir,
        workflow_journal_dir=_configured_path(
            values.get("RIDER_WORKFLOW_JOURNAL_DIR"), workflow_dir / "journals", root,
        ),
        activity_workflow_dir=_configured_path(
            values.get("RIDER_ACTIVITY_WORKFLOW_DIR"), workflow_dir / "activity-runs", root,
        ),
        log_dir=_configured_path(values.get("RIDER_LOG_DIR"), data_root / "logs", root),
        cache_dir=_configured_path(values.get("RIDER_CACHE_DIR"), data_root / "cache", root),
        evaluation_artifact_dir=_configured_path(
            values.get("RIDER_EVALUATION_ARTIFACT_DIR"), data_root / "artifacts" / "evaluation", root,
        ),
        migration_dir=_configured_path(
            values.get("RIDER_MIGRATION_DIR"), data_root / "migrations", root,
        ),
        legacy_athlete_file=data_root / "athlete.json",
    )


def resolve_project_path(path: str | Path, *, base: Path | None = None) -> Path:
    """Resolve a persisted path without making it depend on the process cwd."""
    # Persisted paths use '/' on every platform; also accept older Windows rows.
    candidate = Path(portable_path_text(path)).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    return (project_root(base=base) / candidate).resolve()


def project_relative_or_absolute(path: str | Path, *, base: Path | None = None) -> str:
    """Return a portable project-relative path, or an absolute path outside it."""
    candidate = resolve_project_path(path, base=base)
    root = project_root(base=base)
    try:
        return candidate.relative_to(root).as_posix()
    except ValueError:
        return candidate.as_posix()


def portable_path_text(path: str | Path) -> str:
    """Rider persisted path syntax treats both slash forms as separators."""
    return str(path).replace("\\", "/")


def persisted_path_variants(path: str | Path) -> tuple[str, ...]:
    """Indexed lookup aliases for historical relative/absolute Windows paths.

    Absolute paths remain local to the current OS; this does not guess drive
    mappings between Windows and WSL. Shared databases should use relative paths.
    """
    resolved = resolve_project_path(path)
    values = (portable_path_text(path), project_relative_or_absolute(resolved), resolved.as_posix())
    return tuple(dict.fromkeys(alias for value in values for alias in (value, value.replace("/", "\\"))))


def _root_from(values: Mapping[str, str], *, base: Path | None) -> Path:
    if base is not None:
        return Path(base).expanduser().resolve()
    configured = values.get("RIDER_PROJECT_ROOT")
    return Path(configured).expanduser().resolve() if configured else DEFAULT_PROJECT_ROOT


def _optional_path(value: str | None, root: Path) -> Path | None:
    if value is None or not str(value).strip():
        return None
    return _configured_path(value, root, root)


def _configured_path(value: str | None, fallback: Path, root: Path) -> Path:
    candidate = Path(str(value)).expanduser() if value is not None and str(value).strip() else fallback
    if not candidate.is_absolute():
        candidate = root / candidate
    return candidate.resolve()
