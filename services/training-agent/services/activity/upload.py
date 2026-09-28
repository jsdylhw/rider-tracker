"""Managed FIT uploads. File validation precedes the single ingestion transaction."""
from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

from project_paths import runtime_paths, resolve_project_path
from services.activity.ingestion import ingest_fit_activity
from services.activity.rider_view import canonical_detail_to_rider_activity
from services.activity.session_archive import normalize_rider_session
from storage.repositories.activity import ActivityStore


class ActivityNotFound(ValueError):
    pass


def upload_fit(content: bytes, *, filename: str, kind: str, activity_id: str | None = None,
               session: dict | None = None, name: str = '', sport_type: str = 'Ride') -> dict:
    store = ActivityStore()
    existing = store.get_rider_activity(activity_id, include_raw_session=True) if activity_id else None
    if kind == 'attach' and existing is None:
        raise ActivityNotFound('Activity not found.')
    if not content:
        raise ValueError('FIT file is empty.')
    normalized = normalize_rider_session(session, name=name, sport_type=sport_type) if session is not None else None
    route_link = None
    if normalized and normalized['saved_route_id']:
        route_link = {key: normalized[source] for key, source in (
            ('saved_route_id', 'saved_route_id'), ('start_distance_meters', 'route_start_distance_meters'),
            ('end_distance_meters', 'route_end_distance_meters'))}
    if kind == 'beacon':
        if normalized is None:
            raise ValueError('Missing compact session metadata.')
        activity_id, source, name = normalized['id'], session.get('source') or 'beacon', normalized['name']
    elif kind == 'import':
        activity_id = 'fit-' + hashlib.sha256(content).hexdigest()[:16]
        source = 'fit-import'
        name = name.strip() or Path(filename.replace('\\', '/')).name or activity_id
    else:
        source, name = existing.get('source') or 'rider-tracker', existing.get('name')
    paths = runtime_paths()
    paths.fit_root.mkdir(parents=True, exist_ok=True)
    current = store.get_rider_activity(activity_id)
    fit_path = None
    if current and current.get('fitFilePath'):
        candidate = resolve_project_path(current['fitFilePath'])
        if candidate.is_relative_to(paths.fit_root) and candidate.is_file() and candidate.stat().st_size == len(content):
            if hashlib.sha256(candidate.read_bytes()).digest() == hashlib.sha256(content).digest():
                fit_path = candidate
    created_file = fit_path is None
    # Unique immutable path: a failed attachment can never overwrite an earlier FIT.
    if created_file:
        try:
            with tempfile.NamedTemporaryFile(prefix='upload-', suffix='.fit', dir=paths.fit_root, delete=False) as file:
                fit_path = Path(file.name)
                file.write(content)
        except Exception:
            if fit_path is not None:
                fit_path.unlink(missing_ok=True)
            raise
    try:
        result = ingest_fit_activity(fit_path, activity_key=activity_id, source=source, name=name,
                                     route_link=route_link, raw_session=session)
        activity = canonical_detail_to_rider_activity(result['detail'], result['rider_activity'])
    except Exception:
        # Ingestion's transaction may have committed before a subsequent presentation read failed.
        # Keep a referenced file (or an uncertain one) so error cleanup cannot corrupt the database.
        try:
            saved = store.get_activity(activity_id)
            referenced = saved and resolve_project_path(saved.get('fit_path', '')) == fit_path
        except Exception:
            referenced = True
        if created_file and not referenced:
            fit_path.unlink(missing_ok=True)
        raise
    response = {'ok': True, 'activity': activity}
    if kind == 'attach':
        response['fitFile'] = {'path': activity['fitFilePath'], 'sizeBytes': len(content)}
    return response
