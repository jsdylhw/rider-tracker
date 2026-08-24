"""Single-source athlete profile service with legacy/config migration."""

from __future__ import annotations

from typing import Any

from domain.athlete import (
    DEFAULT_ATHLETE_PATH,
    athlete_profile_to_rider_settings,
    load_athlete_profile as load_profile_file,
    normalize_athlete_profile,
)
from settings import load_config
from storage.repositories.athlete import AthleteProfileStore


def get_athlete_profile() -> dict[str, Any]:
    store = AthleteProfileStore()
    stored = store.get_profile()
    if stored:
        return stored
    configured = normalize_athlete_profile(load_config().get("athlete") or {})
    legacy = normalize_athlete_profile(load_profile_file(DEFAULT_ATHLETE_PATH))
    migrated = _merge_profiles(configured, legacy)
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
        "schema_version": "athlete_profile.v1",
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
