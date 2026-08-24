"""Project path serialization helpers.

Artifacts are normally stored relative to the project working directory, but
CLI callers may explicitly analyze FIT files outside that directory.  In that
case an absolute canonical path is the only lossless representation.
"""

from __future__ import annotations

from pathlib import Path


def project_relative_or_absolute(path: str | Path, *, base: Path | None = None) -> str:
    """Return a project-relative path when possible, otherwise a canonical absolute path."""
    candidate = Path(path).expanduser().resolve()
    root = (base or Path.cwd()).expanduser().resolve()
    try:
        return str(candidate.relative_to(root))
    except ValueError:
        return str(candidate)
