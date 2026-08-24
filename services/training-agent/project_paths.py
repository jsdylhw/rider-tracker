"""Process-independent project path helpers.

This module is deliberately free of storage or service dependencies so that
domain and FIT code can resolve persisted paths without crossing layer bounds.
"""

from __future__ import annotations

import os
from pathlib import Path


def project_root(*, base: Path | None = None) -> Path:
    """Return the path base shared by persisted Rider/Agent relative paths."""
    configured = os.environ.get("RIDER_PROJECT_ROOT")
    configured_root = Path(configured) if configured else None
    return (base or configured_root or Path.cwd()).expanduser().resolve()


def resolve_project_path(path: str | Path, *, base: Path | None = None) -> Path:
    """Resolve a persisted path without making it depend on the process cwd."""
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    return (project_root(base=base) / candidate).resolve()


def project_relative_or_absolute(path: str | Path, *, base: Path | None = None) -> str:
    """Return a project-relative path when possible, otherwise an absolute path."""
    candidate = Path(path).expanduser().resolve()
    root = project_root(base=base)
    try:
        return str(candidate.relative_to(root))
    except ValueError:
        return str(candidate)
