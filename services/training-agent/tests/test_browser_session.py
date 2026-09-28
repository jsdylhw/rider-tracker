"""Browser authentication never publishes the internal service token."""
from fastapi.testclient import TestClient
from app.browser_session import COOKIE
from tests.test_api import _prepare_api


def test_local_page_establishes_session_but_internal_api_still_requires_token(tmp_path, monkeypatch):
    api, internal, _ = _prepare_api(tmp_path, monkeypatch, web_api_token='private-service-token')
    from app.browser import create_browser_app
    client = TestClient(create_browser_app())
    assert client.get('/api/activities').status_code == 401
    root = client.get('/')
    assert root.status_code == 200
    assert 'private-service-token' not in root.text
    assert client.cookies.get(COOKIE)
    assert 'HttpOnly' in root.headers['set-cookie']
    assert 'SameSite=strict' in root.headers['set-cookie']
    assert client.get('/api/activities').status_code == 200
    assert client.get('/api/agent/sessions').status_code == 200
    internal.cookies.set(COOKIE, client.cookies.get(COOKIE))
    assert internal.get('/api/activities').status_code == 401
    assert internal.get('/api/activities', headers={'X-API-Token': 'private-service-token'}).status_code == 200
    assert client.get('/api/activities', headers={'Origin': 'https://evil.test'}).status_code == 403


def test_untrusted_host_cannot_bootstrap_session_and_forged_cookie_is_rejected(tmp_path, monkeypatch):
    api, _, _ = _prepare_api(tmp_path, monkeypatch, web_api_token='private-service-token')
    from app.browser import create_browser_app
    client = TestClient(create_browser_app())
    assert COOKIE not in client.get('/', headers={'Host': 'evil.test'}).cookies
    assert COOKIE not in client.get('/', headers={'Origin': 'https://evil.test'}).cookies
    client.cookies.set(COOKIE, 'forged')
    assert client.get('/api/activities').status_code == 401
    # Explicit API access remains available without a browser session.
    assert client.get('/api/activities', headers={'X-API-Token': 'private-service-token'}).status_code == 200


def test_restart_requires_new_local_session(tmp_path, monkeypatch):
    api, _, _ = _prepare_api(tmp_path, monkeypatch, web_api_token='private-service-token')
    from app.browser import create_browser_app
    before, after = TestClient(create_browser_app()), TestClient(create_browser_app())
    before.get('/')
    after.cookies.set(COOKIE, before.cookies.get(COOKIE))
    assert after.get('/api/activities').status_code == 401
    after.cookies.clear()
    after.get('/')
    assert after.get('/api/activities').status_code == 200


def test_remote_client_cannot_get_local_session(tmp_path, monkeypatch):
    _, _, _ = _prepare_api(tmp_path, monkeypatch, web_api_token='private-service-token')
    from app.browser import create_browser_app
    app = create_browser_app()
    async def remote(scope, receive, send):
        if scope['type'] == 'http':
            scope = {**scope, 'client': ('198.51.100.2', 1234)}
        await app(scope, receive, send)
    client = TestClient(remote)
    assert COOKIE not in client.get('/').cookies
    assert client.get('/api/activities').status_code == 401
