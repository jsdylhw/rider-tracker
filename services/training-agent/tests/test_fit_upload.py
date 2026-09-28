"""Multipart contracts and failure boundaries, isolated from user files/accounts."""
import json

import pytest
from project_paths import runtime_paths, resolve_project_path
from storage.repositories.activity import ActivityStore
from tests.test_api import _prepare_api


@pytest.fixture
def upload_client(tmp_path, monkeypatch, sample_parsed_fit):
    api, client, _ = _prepare_api(tmp_path, monkeypatch)
    monkeypatch.setattr('services.activity.ingestion.parse_fit', lambda path: sample_parsed_fit)
    return client


def _upload(client, endpoint='/api/activities/fit-import', content=b'valid-fit', **fields):
    return client.post(endpoint, files={'file': ('../../ride.fit', content, 'application/octet-stream')}, data=fields)


def test_import_and_reimport_keep_identity_and_browser_shape(upload_client):
    first = _upload(upload_client).json()
    assert first['ok'] is True
    activity = first['activity']
    assert activity['rawSession']['records']
    assert activity['rawSession']['summary']['metrics']['ride']['distanceKm'] == activity['distanceKm']
    fit = resolve_project_path(activity['fitFilePath'])
    assert fit.parent == runtime_paths().fit_root
    assert fit.read_bytes() == b'valid-fit'
    second = _upload(upload_client, name='Renamed').json()['activity']
    assert second['id'] == activity['id']
    assert second['fitFilePath'] == activity['fitFilePath']
    assert len(list(runtime_paths().fit_root.glob('*.fit'))) == 1
    assert second['name'] == 'Renamed'
    assert ActivityStore().count_activities() == 1


def test_bad_attachment_preserves_old_fit_and_record(upload_client, monkeypatch):
    original = _upload(upload_client).json()['activity']
    def reject(path):
        raise ValueError('Invalid FIT')
    monkeypatch.setattr('services.activity.ingestion.parse_fit', reject)
    before = list(runtime_paths().fit_root.iterdir())
    response = _upload(upload_client, f"/api/activities/{original['id']}/fit", b'broken')
    assert response.status_code == 400
    stored = ActivityStore().get_rider_activity(original['id'])
    assert stored['fitFilePath'] == original['fitFilePath']
    assert resolve_project_path(stored['fitFilePath']).read_bytes() == b'valid-fit'
    assert list(runtime_paths().fit_root.iterdir()) == before


def test_beacon_failure_does_not_archive_half_activity(upload_client, monkeypatch):
    def reject(path):
        raise ValueError('Invalid FIT')
    monkeypatch.setattr('services.activity.ingestion.parse_fit', reject)
    response = _upload(upload_client, '/api/activities/fit-beacon', session=json.dumps({'activityId': 'beacon-bad'}))
    assert response.status_code == 400
    assert ActivityStore().get_activity('beacon-bad') is None
    assert not list(runtime_paths().fit_root.glob('*.fit'))


def test_beacon_metadata_and_attach_are_preserved(upload_client):
    session = {'activityId': 'beacon-good', 'settings': {'ftp': 234},
               'route': {'name': 'Retained route', 'points': [{'lat': 30, 'lng': 120}, {'lat': 31, 'lng': 121}]}}
    first = _upload(upload_client, '/api/activities/fit-beacon', session=json.dumps(session))
    assert first.status_code == 200, first.text
    activity = first.json()['activity']
    assert activity['id'] == 'beacon-good'
    assert activity['source'] == 'beacon'
    assert activity['rawSession']['route'] == session['route']
    second = _upload(upload_client, '/api/activities/beacon-good/fit', content=b'new-fit')
    assert second.status_code == 200, second.text
    assert second.json()['fitFile']['sizeBytes'] == 7
    assert second.json()['activity']['rawSession']['route'] == session['route']


@pytest.mark.parametrize('endpoint,fields,status', [
    ('/api/activities/absent/fit', {}, 404),
    ('/api/activities/fit-beacon', {}, 400),
    ('/api/activities/fit-import', {'session': '[]'}, 400),
    ('/api/activities/fit-import', {'session': '{bad'}, 400),
])
def test_invalid_requests_do_not_write(upload_client, endpoint, fields, status):
    assert _upload(upload_client, endpoint, **fields).status_code == status
    assert not runtime_paths().fit_root.exists()


def test_missing_file_and_size_limit(upload_client, monkeypatch):
    assert upload_client.post('/api/activities/fit-import', data={'name': 'Missing'}).status_code == 400
    monkeypatch.setattr('app.uploads.MAX_BODY_BYTES', 10)
    response = _upload(upload_client)
    assert response.status_code == 413
    assert not runtime_paths().fit_root.exists()


def test_origin_and_token_protect_upload_before_writes(tmp_path, monkeypatch):
    _, client, _ = _prepare_api(tmp_path, monkeypatch, web_api_token='test-secret')
    assert _upload(client).status_code in (401, 403)
    response = client.post('/api/activities/fit-import', headers={'Origin': 'https://evil.test'}, files={'file': ('ride.fit', b'fit')})
    assert response.status_code == 403
    assert not runtime_paths().fit_root.exists()


def test_invalid_route_link_rolls_back_beacon(upload_client):
    response = _upload(upload_client, '/api/activities/fit-beacon', session=json.dumps({
        'activityId': 'bad-route', 'route': {'savedRouteId': 'absent-route'},
    }))
    assert response.status_code == 400
    assert ActivityStore().get_activity('bad-route') is None
    assert not list(runtime_paths().fit_root.glob('*.fit'))


def test_busy_database_returns_retryable_and_cleans_file(upload_client, monkeypatch):
    from storage.repositories.activity import ActivityStoreBusy
    def busy(*args, **kwargs):
        raise ActivityStoreBusy('Activity store busy')
    monkeypatch.setattr(ActivityStore, 'save_fit_ingestion', busy)
    response = _upload(upload_client)
    assert response.status_code == 503
    assert response.json()['code'] == 'activity_store_busy'
    assert response.json()['retryable'] is True
    assert not list(runtime_paths().fit_root.glob('*.fit'))


def test_chunked_body_without_content_length_is_bounded(upload_client, monkeypatch):
    monkeypatch.setattr('app.uploads.MAX_BODY_BYTES', 10)
    response = upload_client.post('/api/activities/fit-import',
                                  content=iter([b'x' * 6, b'x' * 6]),
                                  headers={'Content-Type': 'multipart/form-data; boundary=test'})
    assert response.status_code == 413
    assert not runtime_paths().fit_root.exists()


def test_projection_preserves_energy_and_clears_stale_report():
    from services.activity.rider_view import canonical_detail_to_rider_activity
    fallback = {'id': 'fit-test', 'analysisReport': {'markdown_report': 'old'},
                'rawSession': {'summary': {'metrics': {'energy': {
                    'estimatedCaloriesKcal': 42, 'mechanicalWorkKj': 40, 'method': 'power',
                }}}}}
    result = canonical_detail_to_rider_activity({'activity': {'activity_key': 'fit-test'}, 'report': None}, fallback)
    assert result['analysisReport'] is None
    assert result['rawSession']['summary']['metrics']['energy'] == fallback['rawSession']['summary']['metrics']['energy']
    result = canonical_detail_to_rider_activity({'metrics': {'scale': {'calories': 0}, 'power': {'total_work_kj': 0}}}, fallback)
    assert result['rawSession']['summary']['metrics']['energy'] == {
        'estimatedCaloriesKcal': 0, 'mechanicalWorkKj': 0, 'method': 'fit',
    }
