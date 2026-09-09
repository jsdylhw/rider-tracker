"""Explicit, copy-first migration of legacy mutable Rider directories."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from project_paths import RuntimePaths


MIGRATION_SCHEMA = "runtime_data_migration.v1"
MIGRATION_NAME = "runtime-path-v1"


@dataclass(frozen=True)
class MigrationEntry:
    category: str
    source: Path
    target: Path
    status: str
    sensitive: bool = False


def audit_runtime_data(paths: RuntimePaths) -> dict[str, Any]:
    """Return a deterministic plan without modifying files."""
    manifest = paths.migration_dir / f"{MIGRATION_NAME}.json"
    entries = _build_entries(paths)
    manual = _legacy_databases(paths)
    counts = _counts(entries)
    return {
        "schema_version": MIGRATION_SCHEMA,
        "migration": MIGRATION_NAME,
        "mode": "audit",
        "status": "already_applied" if manifest.exists() else (
            "conflict" if counts["conflict"] else "ready"
        ),
        "project_root": str(paths.project_root),
        "data_root": str(paths.data_root),
        "manifest": str(manifest),
        "summary": counts,
        "entries": [_public_entry(entry) for entry in entries],
        "manual_review": [
            {
                "category": "legacy_database",
                "path": str(path),
                "reason": "SQLite databases are never merged automatically.",
            }
            for path in manual
        ],
    }


def migrate_runtime_data(paths: RuntimePaths) -> dict[str, Any]:
    """Copy one audited legacy layout into canonical paths exactly once."""
    plan = audit_runtime_data(paths)
    manifest = Path(plan["manifest"])
    if manifest.exists():
        return plan
    if plan["summary"]["conflict"]:
        raise RuntimeError("runtime data migration has conflicts; run data:audit and resolve them first")

    copied: list[dict[str, str]] = []
    for entry in _build_entries(paths):
        if entry.status != "copy":
            continue
        entry.target.parent.mkdir(parents=True, exist_ok=True)
        temporary = entry.target.with_name(f".{entry.target.name}.runtime-migration.tmp")
        shutil.copy2(entry.source, temporary)
        if _digest(temporary) != _digest(entry.source):
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"copy verification failed: {entry.source}")
        os.replace(temporary, entry.target)
        if entry.sensitive:
            os.chmod(entry.target, 0o600)
        copied.append({"source": str(entry.source), "target": str(entry.target)})

    manifest.parent.mkdir(parents=True, exist_ok=True)
    document = {
        **plan,
        "mode": "migrate",
        "status": "completed",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "copied": copied,
        "source_files_retained": True,
    }
    temporary_manifest = manifest.with_name(f".{manifest.name}.tmp")
    temporary_manifest.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    os.replace(temporary_manifest, manifest)
    return document


def _build_entries(paths: RuntimePaths) -> list[MigrationEntry]:
    root = paths.project_root
    agent = root / "services" / "training-agent"
    specifications = [
        ("strava_token", root / "data" / "strava-tokens.json", paths.strava_token_store, True),
        ("strava_token", agent / "data" / "strava-tokens.json", paths.strava_token_store, True),
        ("activity_workflow", root / "data" / "activity_runs", paths.activity_workflow_dir, False),
        ("activity_workflow", agent / "data" / "activity_runs", paths.activity_workflow_dir, False),
        ("workflow_journal", root / "data" / "runs", paths.workflow_journal_dir, False),
        ("workflow_journal", agent / "data" / "runs", paths.workflow_journal_dir, False),
        ("agent_log", root / "log", paths.log_dir, False),
        ("agent_log", agent / "log", paths.log_dir, False),
        ("evaluation_artifact", root / "evaluation" / "artifacts", paths.evaluation_artifact_dir, False),
        ("evaluation_artifact", agent / "evaluation" / "artifacts", paths.evaluation_artifact_dir, False),
        ("garmin_fit", root / "garmin_cn_fit_files", paths.garmin_fit_dir, False),
        ("garmin_fit", agent / "garmin_cn_fit_files", paths.garmin_fit_dir, False),
    ]
    entries: list[MigrationEntry] = []
    for category, source, target, sensitive in specifications:
        if source.resolve() == target.resolve():
            continue
        if source.is_file():
            entries.append(_entry(category, source, target, sensitive=sensitive))
        elif source.is_dir():
            for item in sorted(path for path in source.rglob("*") if path.is_file()):
                entries.append(_entry(
                    category, item, target / item.relative_to(source), sensitive=sensitive,
                ))
    return _resolve_source_collisions(entries)


def _entry(category: str, source: Path, target: Path, *, sensitive: bool) -> MigrationEntry:
    if not target.exists():
        status = "copy"
    elif target.is_file() and _digest(source) == _digest(target):
        status = "identical"
    else:
        status = "conflict"
    return MigrationEntry(category, source.resolve(), target.resolve(), status, sensitive)


def _resolve_source_collisions(entries: list[MigrationEntry]) -> list[MigrationEntry]:
    """Detect multiple legacy sources targeting one previously absent file."""
    grouped: dict[Path, list[int]] = {}
    for index, entry in enumerate(entries):
        grouped.setdefault(entry.target, []).append(index)
    resolved = list(entries)
    for indexes in grouped.values():
        pending = [index for index in indexes if entries[index].status == "copy"]
        if len(pending) < 2:
            continue
        digests = {_digest(entries[index].source) for index in pending}
        if len(digests) > 1:
            for index in pending:
                resolved[index] = replace(entries[index], status="conflict")
            continue
        for index in pending[1:]:
            resolved[index] = replace(entries[index], status="identical")
    return resolved


def _legacy_databases(paths: RuntimePaths) -> list[Path]:
    root = paths.project_root
    candidates = [
        root / "data" / "personal-fit-agent.db",
        root / "data" / "rider-tracker.sqlite",
        root / "services" / "training-agent" / "data" / "personal-fit-agent.db",
    ]
    return [path.resolve() for path in candidates if path.is_file() and path.resolve() != paths.database]


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _counts(entries: list[MigrationEntry]) -> dict[str, int]:
    result = {"copy": 0, "identical": 0, "conflict": 0}
    for entry in entries:
        result[entry.status] += 1
    return result


def _public_entry(entry: MigrationEntry) -> dict[str, Any]:
    result = asdict(entry)
    result["source"] = str(entry.source)
    result["target"] = str(entry.target)
    return result
