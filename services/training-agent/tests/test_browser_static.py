"""Opt-in static delivery: real source assets, isolated data and path boundaries."""
import pytest
from fastapi.testclient import TestClient

from app import api
from app.browser import ASSET_ROOT, create_browser_app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(api, 'load_config', lambda: {})
    return TestClient(create_browser_app())


def test_same_rider_document_and_default_backend_unchanged(client):
    response = client.get('/')
    assert response.status_code == 200
    assert response.content == (ASSET_ROOT / 'index.html').read_bytes()
    assert response.headers['content-type'].startswith('text/html')
    assert client.head('/').content == b''
    assert TestClient(api.app).get('/').json()['service'] == 'rider-training-backend'
    assert client.get('/healthz').json()['service'] == 'rider-tracker'
    assert client.get('/api/agent/chat').status_code == 405
    assert TestClient(api.app).get('/api/agent/chat').status_code == 404
    assert client.get('/not-a-page').status_code == 404


def test_all_local_browser_js_and_css_resources(client):
    # Check all modules, including lazily loaded ones, against real checkout bytes.
    roots = ['adapters', 'app', 'domain', 'shared', 'styles', 'ui']
    paths = [ASSET_ROOT / 'src/style.css']
    for root in roots:
        paths.extend(p for p in (ASSET_ROOT / 'src' / root).rglob('*') if p.suffix in {'.js', '.css'})
    for path in paths:
        response = client.get('/' + path.relative_to(ASSET_ROOT).as_posix())
        assert response.status_code == 200, path
        assert response.content == path.read_bytes()
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert response.headers['content-type'].startswith('text/javascript' if path.suffix == '.js' else 'text/css')


@pytest.mark.parametrize('url', ['/', '/src/style.css', '/src/app/bootstrap.js'])
def test_revalidation_and_head(client, url):
    response = client.get(url)
    assert response.headers['cache-control'] == 'no-cache'
    assert client.get(url, headers={'If-None-Match':response.headers['etag']}).status_code == 304
    assert client.get(url, headers={'If-Modified-Since':response.headers['last-modified']}).status_code == 304
    head = client.head(url)
    assert head.status_code == 200 and head.content == b''
    assert head.headers['content-length'] == response.headers['content-length']
    assert client.post(url).status_code == 405


@pytest.mark.parametrize('url', ['/config.yaml','/.env','/data/credentials/token.json','/src/server/index.js',
    '/src/app/__init__.py','/src/app/.secret.js','/src/%2e%2e/config.yaml','/src/app/%2e%2e/server/index.js',
    '/src/%252e%252e/config.yaml','/src/app%5c..%5cserver%5cindex.js','/vendor/@garmin/fitsdk/package.json',
    '/src/app/','/static/app.js','/src/app/%00.js','/vendor/@garmin/fitsdk/index.html'])
def test_private_paths_never_served(client, url):
    assert client.get(url).status_code == 404


def test_symlink_and_missing_vendor(tmp_path):
    (tmp_path / 'src/app').mkdir(parents=True)
    (tmp_path / 'private.js').write_text('private')
    link = tmp_path / 'src/app/leak.js'
    try:
        link.symlink_to(tmp_path / 'private.js')
    except OSError:
        pytest.skip('symlinks unavailable')
    client = TestClient(create_browser_app(tmp_path))
    assert client.get('/src/app/leak.js').status_code == 404
    assert client.get('/vendor/@garmin/fitsdk/src/index.js').status_code == 404


def test_vendor_modules_and_api_guard(tmp_path, monkeypatch):
    sdk = tmp_path / 'node_modules/@garmin/fitsdk/src'
    sdk.mkdir(parents=True)
    (sdk / 'index.js').write_text('export const sdk = true;')
    monkeypatch.setattr(api, 'load_config', lambda: {})
    client = TestClient(create_browser_app(tmp_path))
    assert client.get('/vendor/@garmin/fitsdk/src/index.js').text == 'export const sdk = true;'
    assert client.get('/api/runtime-config/maps', headers={'Host':'evil.example'}).status_code == 400
    assert client.get('/api/runtime-config/maps', headers={'Origin':'https://evil.example'}).status_code == 403


def test_windows_internal_separators_do_not_allow_input_backslashes(tmp_path, monkeypatch):
    from app import browser
    from starlette.exceptions import HTTPException
    files = browser.BrowserFiles(tmp_path)
    monkeypatch.setattr(browser.StaticFiles, 'get_path', lambda self, scope: 'app\\bootstrap.js')
    monkeypatch.setattr(browser.os, 'sep', '\\')
    assert files.get_path({'path': '/src/app/bootstrap.js'}) == 'app/bootstrap.js'
    with pytest.raises(HTTPException) as denied:
        files.get_path({'path': '/src/app\\bootstrap.js'})
    assert denied.value.status_code == 404
