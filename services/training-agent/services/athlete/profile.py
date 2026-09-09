"""Single-source athlete profile service with legacy/config migration."""

from __future__ import annotations

from typing import Any

from domain.contracts.schemas import ATHLETE_PROFILE_V1
from domain.athlete import (
    athlete_profile_to_rider_settings,
    load_athlete_profile as load_profile_file,
    normalize_athlete_profile,
)
from project_paths import runtime_paths
from settings import load_config
from storage.repositories.athlete import AthleteProfileStore


# Test/extension override. Production resolves the runtime path at call time.
DEFAULT_ATHLETE_PATH = None


def get_athlete_profile() -> dict[str, Any]:
    store = AthleteProfileStore()
    stored = store.get_profile()
    if stored:
        return stored
    configured = normalize_athlete_profile(load_config().get("athlete") or {})
    paths = runtime_paths()
    legacy_path = DEFAULT_ATHLETE_PATH or paths.legacy_athlete_file
    legacy = normalize_athlete_profile(load_profile_file(legacy_path))
    migrated = _merge_profiles(configured, legacy)
    if not migrated and DEFAULT_ATHLETE_PATH is None:
        # Rider originally stored the same flat settings at the repository
        # root.  Read that file only while the canonical database profile is
        # empty; once imported, all later reads come from AthleteProfileStore.
        rider_legacy = normalize_athlete_profile(
            load_profile_file(paths.project_root / "user-profile.json"),
        )
        migrated = _merge_profiles(migrated, rider_legacy)
    if migrated:
        store.save_profile(migrated)
    return migrated


def update_athlete_profile(patch: dict[str, Any]) -> dict[str, Any]:
    current = normalize_athlete_profile(get_athlete_profile())
    incoming = normalize_athlete_profile(patch)
    merged = _merge_profiles(current, incoming)
    return AthleteProfileStore().save_profile(merged)


def athlete_profile_response(profile: dict[str, Any] | None = None) -> dict[str, Any]:
    resolved = profile if profile is not None else get_athlete_profile()
    return {
        "schema_version": ATHLETE_PROFILE_V1,
        "configured": bool(resolved),
        "profile": resolved,
        "rider_settings": athlete_profile_to_rider_settings(resolved),
    }


def _merge_profiles(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Merge canonical profile sections field-by-field; override wins."""
    return {
        section: {**(base.get(section) or {}), **(override.get(section) or {})}
        for section in {**base, **override}
    }
