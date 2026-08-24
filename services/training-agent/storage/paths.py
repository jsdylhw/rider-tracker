"""Compatibility exports for project path helpers.

New code should import :mod:`project_paths`; this module remains so older
storage callers and extensions do not break during the repository migration.
"""

from __future__ import annotations

from project_paths import project_relative_or_absolute, project_root, resolve_project_path

__all__ = ["project_relative_or_absolute", "project_root", "resolve_project_path"]
