"""Structural parity at the Browser boundary, using isolated backend stores."""
import json
from pathlib import Path
import re

import pytest
from fastapi.testclient import TestClient
from tests.test_api import _prepare_api


@pytest.fixture
def browser(tmp_path, monkeypatch):
    api, _, _ = _prepare_api(tmp_path, monkeypatch)
    from app.browser import create_browser_app
    return api, TestClient(create_browser_app())


def test_every_browser_contract_path_is_present(browser):
    _, client = browser
    contract = json.loads((Path(__file__).resolve().parents[3] / 'tests/contracts/rider-browser-http-api.v1.json').read_text())
    normalize = lambda path: re.sub(r'\{[^}]+\}', '{}', path)
    actual = {(method.upper(), normalize(path)) for path, operations in client.app.openapi()['paths'].items()
              for method in operations if method in {'get', 'post', 'put', 'patch', 'delete'}}
    assert client.get('/').status_code == 200
    actual.add(('GET', '/'))
    expected = {(route['method'], normalize(route['path'])) for route in contract['routes']}
    assert expected <= actual


def test_narration_browser_normalization_and_job_envelope(browser, monkeypatch):
    api, client = browser
    calls = []
    def submit(body, request):
        calls.append(body)
        return {'job_id': 'test-job', 'status': 'queued'}
    monkeypatch.setattr(api, 'prepare_route_narration_endpoint', submit)
    response = client.post('/api/route-narrations/prepare', json={
        'route_fingerprint': 'route_1234abcd', 'route_name': ' Route ', 'total_distance_m': 1000.1,
        'estimated_duration_min': 10, 'samples': [{'route_distance_m': 0, 'latitude': 30, 'longitude': 120},
                                                {'route_distance_m': 1000.5, 'latitude': 30.01, 'longitude': 120.01}],
    })
    assert response.status_code == 202, response.text
    assert response.json()['result']['job_id'] == 'test-job'
    assert calls[0].samples[-1].route_distance_m == 1000.1
    assert calls[0].samples[0].sample_id == 'sample_1'
    assert client.get('/api/route-narrations/photo?name=invalid').status_code == 400


def test_route_crud_uses_browser_success_status_and_preserves_repository_errors(browser):
    _, client = browser
    result = client.post('/api/routes', json={'source': 'gpx', 'route': {'name': 'Test', 'points': [
        {'latitude': 30, 'longitude': 120}, {'latitude': 30.01, 'longitude': 120.01}],
        'totalDistanceMeters': 1500}})
    assert result.status_code == 201, result.text
    route_id = result.json()['route']['id']
    assert result.json()['ok'] is True
    renamed = client.patch('/api/routes/' + route_id, json={'name': 'Updated'})
    assert renamed.json()['route']['name'] == 'Updated'
    assert client.delete('/api/routes/' + route_id).json()['ok'] is True
    missing = client.get('/api/routes/' + route_id)
    assert missing.status_code == 404
    assert missing.json()['ok'] is False


def test_activity_detail_projects_fit_for_browser(browser, monkeypatch):
    api, client = browser
    monkeypatch.setattr(api, 'get_activity_endpoint', lambda *args: {'activity': {'id': 'fit-a', 'fitFilePath': 'fixture.fit'}})
    seen = []
    def detail(activity_id, request, *, view):
        seen.append((activity_id, view))
        return {'id': activity_id, 'rawSession': {'records': [{'power': 100}]}}
    monkeypatch.setattr(api, 'activity_detail_endpoint', detail)
    result = client.get('/api/activities/fit-a')
    assert result.json()['activity']['rawSession']['records'][0]['power'] == 100
    assert seen == [('fit-a', 'rider')]


@pytest.mark.parametrize('field', ['latitude', 'longitude', 'route_distance_m'])
def test_narration_missing_coordinate_never_becomes_zero(browser, monkeypatch, field):
    api, client = browser
    def forbidden(*args):
        pytest.fail('Malformed location must not reach the job submission')
    monkeypatch.setattr(api, 'prepare_route_narration_endpoint', forbidden)
    sample = {'latitude': 30, 'longitude': 120, 'route_distance_m': 0}
    del sample[field]
    response = client.post('/api/route-narrations/prepare', json={
        'route_fingerprint': 'route_1234abcd', 'route_name': 'Test', 'total_distance_m': 1000,
        'estimated_duration_min': 10, 'samples': [sample, {'latitude': 30.01, 'longitude': 120.01, 'route_distance_m': 1000}],
    })
    assert response.status_code == 400
    assert field in response.json()['error']


@pytest.mark.parametrize('endpoint,handler', [('/api/routes', 'list_saved_routes_endpoint'),
    ('/api/activities', 'list_activities_endpoint'), ('/api/route-narrations/jobs/test', 'get_route_narration_endpoint')])
def test_unexpected_failure_keeps_json_envelope_without_private_details(browser, monkeypatch, endpoint, handler):
    api, client = browser
    def failed(*args, **kwargs):
        raise RuntimeError('private diagnostic fixture')
    monkeypatch.setattr(api, handler, failed)
    response = client.get(endpoint)
    assert response.status_code == 500
    assert response.json() == {'ok': False, 'error': 'Backend request failed.'}
