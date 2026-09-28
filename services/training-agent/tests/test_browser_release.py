"""Built assets remain usable without the source tree or node_modules."""
import importlib.util

import pytest
from fastapi.testclient import TestClient

from app import api
from app.browser import ASSET_ROOT, create_browser_app

spec = importlib.util.spec_from_file_location('build_browser_assets', ASSET_ROOT / 'scripts/build-browser-assets.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def test_exported_release_uses_only_public_assets(tmp_path, monkeypatch):
    output = tmp_path / 'release'
    manifest = builder.build(ASSET_ROOT, output)
    assert manifest['schema_version'] == 'rider_browser_assets.v1'
    assert not (output / 'node_modules').exists()
    assert not (output / 'src/server').exists()
    assert not (output / 'config.yaml').exists()
    monkeypatch.setenv('RIDER_BROWSER_ASSET_ROOT', str(output))
    monkeypatch.setattr(api, 'load_config', lambda: {})
    client = TestClient(create_browser_app())
    for relative in manifest['files']:
        if relative.endswith(('.js', '.css', '.html')):
            response = client.get('/' if relative == 'index.html' else '/' + relative)
            assert response.status_code == 200, relative
            assert response.content == (output / relative).read_bytes()
    assert client.get('/manifest.json').status_code == 404
    assert client.get('/vendor/@garmin/fitsdk/package.json').status_code == 404
    with pytest.raises(ValueError, match='already exists'):
        builder.build(ASSET_ROOT, output)


def test_export_rejects_missing_sdk_and_symlink_before_writing(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    with pytest.raises(ValueError, match='SDK missing'):
        builder.build(source, tmp_path / 'release')
    assert not (tmp_path / 'release').exists()
    (source / 'src').mkdir()
    (source / 'index.html').write_text('page')
    (source / 'src/style.css').write_text('style')
    sdk = source / 'node_modules/@garmin/fitsdk/src'
    sdk.mkdir(parents=True)
    (sdk / 'index.js').write_text('sdk')
    (source / 'src/app').mkdir()
    try:
        (source / 'src/app/leak.js').symlink_to(source / 'index.html')
    except OSError:
        pytest.skip('symlinks unavailable')
    with pytest.raises(ValueError, match='symbolic-link'):
        builder.build(source, tmp_path / 'release')
    assert not (tmp_path / 'release').exists()
