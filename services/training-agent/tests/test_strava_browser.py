"""Non-Agent browser edge contracts; no real account or token operations."""
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from app.strava_browser import COOKIE, OAuthStates
from tests.test_api import _prepare_api


@pytest.fixture
def edge(tmp_path, monkeypatch):
    api, _, _ = _prepare_api(tmp_path, monkeypatch)
    for key in ('STRAVA_REDIRECT_URI', 'STRAVA_SCOPES', 'FRONTEND_REDIRECT_URL'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(api, 'load_config', lambda: {'strava': {'client_id': 'fake', 'client_secret': 'fake'}})
    calls = []
    class Sink:
        def __init__(self, **kwargs):
            pass
        def build_authorize_url(self, **kwargs):
            from urllib.parse import urlencode
            return 'https://strava.example/authorize?' + urlencode(kwargs)
        def exchange_authorization_code(self, code):
            calls.append(code)
            return {'access_token': 'never-exposed'}
        def connection_status(self):
            return {'connected': True, 'expires_at': 123}
    monkeypatch.setattr(api, 'StravaSink', Sink)
    from app.browser import create_browser_app
    return api, TestClient(create_browser_app()), calls


def test_auth_success_cookie_binding_and_replay(edge):
    api, client, calls = edge
    start = client.get('/api/strava/auth/start?userId=test')
    assert start.status_code == 200
    assert 'HttpOnly' in start.headers['set-cookie']
    assert 'SameSite=lax' in start.headers['set-cookie']
    state = start.json()['state']
    assert parse_qs(urlsplit(start.json()['authUrl']).query)['redirect_uri'] == ['http://testserver/api/strava/auth/callback']
    callback = '/api/strava/auth/callback?code=fake&scope=read,read_all&state=' + state
    nonce = client.cookies.get(COOKIE)
    client.cookies.clear()
    assert client.get(callback).status_code == 400
    assert calls == []
    client.cookies.set(COOKIE, nonce)
    success = client.get(callback)
    assert success.status_code == 200
    assert 'rider-tracker:strava-connected' in success.text
    assert 'never-exposed' not in success.text
    assert client.get(callback).status_code == 400
    assert calls == ['fake']


@pytest.mark.parametrize('suffix', ['&error=access_denied', '&code=fake&scope=read', '&scope=read,read_all'])
def test_callback_failure_does_not_exchange(edge, suffix):
    _, client, calls = edge
    state = client.get('/api/strava/auth/start').json()['state']
    assert client.get('/api/strava/auth/callback?state=' + state + suffix).status_code == 400
    assert calls == []


def test_state_expiry():
    clock = [0]
    states = OAuthStates(now=lambda: clock[0])
    state = states.create('default', 'nonce')
    clock[0] = 601
    assert states.consume(state, 'nonce') is None


def test_missing_config_and_different_callback_owner(edge, monkeypatch):
    api, client, _ = edge
    monkeypatch.setenv('STRAVA_REDIRECT_URI', 'http://localhost:8787/api/strava/auth/callback')
    assert client.get('/api/strava/auth/start').status_code == 409
    monkeypatch.setattr(api, 'load_config', lambda: {})
    response = client.get('/api/strava/auth/start')
    assert response.status_code == 409
    assert response.json()['configured'] is False


def test_token_and_origin_protection(edge, monkeypatch):
    api, client, calls = edge
    config = api.load_config()
    monkeypatch.setattr(api, 'load_config', lambda: {**config, 'web_api_token': 'test-token'})
    assert client.get('/api/strava/auth/start').status_code == 401
    state = client.get('/api/strava/auth/start', headers={'X-API-Token': 'test-token'}).json()['state']
    # Callback authorization comes from the state and its browser cookie, not the API header.
    assert client.get('/api/strava/auth/callback', params={'state': state, 'code': 'ok', 'scope': 'read,read_all'}).status_code == 200
    assert client.get('/api/strava/auth/start', headers={'Origin': 'https://evil.test'}).status_code == 403
    assert calls == ['ok']


def test_browser_response_adapters_and_upload_arguments(edge, monkeypatch):
    api, client, _ = edge
    assert client.get('/api/strava/config').json()['ok'] is True
    assert client.get('/api/strava/connection?userId=u').json() == {'connected': True, 'expires_at': 123, 'expiresAt': 123, 'userId': 'u'}
    assert client.post('/api/strava/config', json={}).status_code == 409
    assert client.post('/api/strava/upload-fit').status_code == 410
    calls = []
    def upload(request, http_request):
        calls.append(request)
        return {'upload': {'id': 1}}
    monkeypatch.setattr(api, 'strava_upload_activity_endpoint', upload)
    response = client.post('/api/strava/upload-activity-fit', json={'activityId': 'fit-a', 'trainer': 'yes', 'fitDescription': 'first', 'message': 'second'})
    assert response.status_code == 200, response.text
    assert response.json()['activityId'] == 'fit-a'
    assert calls[0].description == 'first\n\nsecond'
    assert calls[0].trainer is True
    assert client.post('/api/strava/upload-activity-fit', json={}).status_code == 400
    monkeypatch.setattr(api, 'strava_upload_status_endpoint', lambda *args: {'id': 1})
    assert client.get('/api/strava/upload-status/1').json()['status'] == {'id': 1}


def test_html_escapes_user_controlled_script_content(edge):
    _, client, _ = edge
    response = client.get('/strava/login', params={'userId': '</script><img src=x onerror=alert(1)>'})
    assert '<img' not in response.text
    assert '\\u003c/script' in response.text


def test_exchange_failure_is_not_retried_on_replayed_callback(edge, monkeypatch):
    api, client, _ = edge
    state = client.get('/api/strava/auth/start').json()['state']
    calls = []
    def fail(self, code):
        calls.append(code)
        raise RuntimeError('Provider unavailable')
    monkeypatch.setattr(api.StravaSink, 'exchange_authorization_code', fail)
    params = {'state': state, 'code': 'fake', 'scope': 'read,read_all'}
    assert client.get('/api/strava/auth/callback', params=params).status_code == 400
    assert client.get('/api/strava/auth/callback', params=params).status_code == 400
    assert calls == ['fake']


def test_frontend_redirect_and_internal_api_remain_separate(edge, monkeypatch):
    api, client, _ = edge
    monkeypatch.setenv('FRONTEND_REDIRECT_URL', 'http://testserver/?tab=account')
    state = client.get('/api/strava/auth/start').json()['state']
    response = client.get('/api/strava/auth/callback', params={'state': state, 'code': 'fake', 'scope': 'read,read_all'}, follow_redirects=False)
    assert response.status_code == 302
    assert parse_qs(urlsplit(response.headers['location']).query)['status'] == ['connected']
    assert parse_qs(urlsplit(response.headers['location']).query)['tab'] == ['account']
    original = TestClient(api.app).get('/api/strava/config').json()
    assert 'ok' not in original
    assert 'client_secret' not in original
    monkeypatch.setenv('FRONTEND_REDIRECT_URL', 'javascript:alert(1)')
    assert client.get('/api/strava/auth/start').status_code == 400


def test_route_catalog_and_gpx_preserve_browser_envelopes(edge, monkeypatch):
    from fastapi.responses import Response
    api, client, _ = edge
    monkeypatch.setattr(api, 'strava_routes_endpoint', lambda request: {'routes': [{'id': '123'}], 'cachedAt': 'test', 'hasCache': True})
    monkeypatch.setattr(api, 'refresh_strava_routes_endpoint', lambda request: {'routes': [], 'cachedAt': 'new'})
    monkeypatch.setattr(api, 'strava_route_gpx_endpoint', lambda route_id, request: Response('<gpx/>', media_type='application/gpx+xml'))
    assert client.get('/api/strava/routes').json() == {'ok': True, 'routes': [{'id': '123'}], 'cachedAt': 'test', 'hasCache': True}
    assert client.post('/api/strava/routes/refresh').json()['hasCache'] is True
    assert client.get('/api/strava/routes/123/gpx').text == '<gpx/>'


def test_upload_network_failure_reaches_browser_as_safe_error(edge, monkeypatch):
    from requests.exceptions import SSLError
    api, client, _ = edge
    def upload(*args, **kwargs):
        raise SSLError('private upstream request')
    monkeypatch.setattr(api, 'upload_stored_activity_fit', upload)
    response = client.post('/api/strava/upload-activity-fit', json={'activityId': 'test'})
    assert response.status_code == 502
    assert response.json()['ok'] is False
    assert 'HTTPS' in response.json()['error']
    assert 'private upstream request' not in response.text
