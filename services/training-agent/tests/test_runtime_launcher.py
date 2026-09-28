"""Synthetic configuration parity and actual isolated Python launch lifecycle."""
import json
import http.cookiejar
import importlib.util
import os
from pathlib import Path
import shutil
import socket
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request

import pytest

from app.runtime_config import build_runtime_environment, load_runtime_environment

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize('values,environment', [
    ({}, {}),
    ({}, {'RIDER_DATA_ROOT': 'relative-data'}),
    ({'rider': {'data_root': 'runtime', 'port': 9000, 'open_browser': False},
      'agent': {'base_url': 'https://example.test/api'}, 'google': {'api_key': 'test-key'},
      'web_api_token': 'test-token'}, {'NO_PROXY': 'localhost'}),
    ({'rider': {'database_path': 'custom.db', 'strava_scopes': 'extra'},
      'training_agent': {'host': '127.0.0.2', 'port': 9001}},
     {'PERSONAL_FIT_AGENT_URL': 'http://127.0.0.3:9002', 'PORT': '9999'}),
])
def test_config_matches_legacy_node_mapping(tmp_path, values, environment):
    if not shutil.which('node'):
        pytest.skip('Node only needed for migration parity checks')
    config_path = tmp_path / 'config.yaml'
    payload = {'root': str(tmp_path), 'config': {'configPath': str(config_path), 'values': values}, 'env': environment}
    code = "import {buildRuntimeEnv} from './scripts/local-config.js'; let s=''; for await (const c of process.stdin) s+=c; const p=JSON.parse(s); process.stdout.write(JSON.stringify(buildRuntimeEnv(p.root,p.config,p.env)));"
    legacy = subprocess.run(['node', '--input-type=module', '-e', code], input=json.dumps(payload),
                            capture_output=True, text=True, cwd=ROOT, check=True)
    assert build_runtime_environment(tmp_path, config_path, values, environment) == json.loads(legacy.stdout)
    if environment.get('RIDER_DATA_ROOT') == 'relative-data':
        assert json.loads(legacy.stdout)['RIDER_TRACKER_DB_PATH'] == str(tmp_path / 'relative-data/rider-tracker.db')


def test_dotenv_and_environment_precedence(tmp_path):
    (tmp_path / '.env').write_text('PORT=9100\nRIDER_OPEN_BROWSER=false\n')
    (tmp_path / 'config.yaml').write_text('rider:\n  port: 9000\n')
    env = load_runtime_environment(tmp_path, {'PORT': '9200'})
    assert env['PORT'] == '9200'
    assert env['RIDER_OPEN_BROWSER'] == 'false'
    assert env['RIDER_TRACKER_DB_PATH'] == str(tmp_path / 'data/rider-tracker.db')


@pytest.mark.parametrize('stop_process,release,npm_entry', [(None, False, False), ('worker.main', False, False), ('app.agent_process', False, False), (None, True, False), (None, False, True)])
def test_python_launcher_serves_and_stops_without_node(tmp_path, stop_process, release, npm_entry):
    if stop_process and sys.platform != 'linux':
        pytest.skip('Linux child-process fault injection; normal lifecycle is cross-platform')
    launch_root = ROOT
    if release:
        spec = importlib.util.spec_from_file_location('release_builder', ROOT / 'scripts/build-rider-release.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        launch_root = tmp_path / 'relocated-release'
        manifest = builder.build(launch_root)
        assert manifest['schema_version'] == 'rider_source_release.v1'
        assert not (launch_root / 'node_modules').exists()
        assert not (launch_root / 'config.yaml').exists()
        assert not (launch_root / 'src/server').exists()
    config = tmp_path / 'config.yaml'
    config.write_text('web_api_token: test-launch-token\n')
    database = tmp_path / 'rider.db'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'RIDER_CONFIG_PATH': str(config), 'TRAINING_AGENT_CONFIG_PATH': str(config),
           'RIDER_ENV_PATH': str(tmp_path / 'absent.env'), 'RIDER_PROJECT_ROOT': str(launch_root),
           'RIDER_DATA_ROOT': str(tmp_path / 'data'), 'RIDER_TRACKER_DB_PATH': str(database),
           'TRAINING_AGENT_DB_PATH': str(database), 'TRAINING_AGENT_MANAGED_DATABASE': '1',
           'FIT_FILE_DIR': str(tmp_path / 'fit'), 'RIDER_OPEN_BROWSER': 'false'}
    command = [sys.executable, str(launch_root / 'scripts/start-rider.py'), '--host', '127.0.0.1', '--port', str(port)]
    if npm_entry:
        if not shutil.which('node'):
            pytest.skip('Node is required for the npm convenience entry')
        scripts = json.loads((ROOT / 'package.json').read_text())['scripts']
        assert scripts['start'] == 'node scripts/start-python.js'
        assert 'scripts/start-local.js' in scripts['start:legacy']
        env.update(PYTHON_EXECUTABLE=sys.executable, HOST='127.0.0.1', PORT=str(port))
        command = ['node', str(ROOT / 'scripts/start-python.js')]
    process = subprocess.Popen(command, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                               creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == 'win32' else 0)
    owned_pids = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    try:
        deadline = time.monotonic() + 30
        while True:
            assert process.poll() is None, process.stderr.read().decode()
            try:
                with opener.open(f'http://127.0.0.1:{port}/', timeout=1) as response:
                    assert b'Rider Tracker' in response.read()
                    assert 'rider_browser_session=' in response.headers['set-cookie']
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    pytest.fail('Python launcher did not become ready')
                time.sleep(.2)
        assert database.is_file()
        if release:
            with opener.open(f'http://127.0.0.1:{port}/vendor/@garmin/fitsdk/src/index.js', timeout=3) as response:
                assert response.status == 200
        request = urllib.request.Request(f'http://127.0.0.1:{port}/api/agent/sessions',
                                         headers={'Origin': f'http://127.0.0.1:{port}'})
        with opener.open(request, timeout=3) as response:
            assert response.status == 200
        while True:
            with sqlite3.connect(database) as connection:
                workers = connection.execute('SELECT COUNT(*) FROM job_workers').fetchone()[0]
            if workers:
                break
            if time.monotonic() >= deadline:
                pytest.fail('Companion Worker did not register')
            time.sleep(.2)
        if npm_entry and sys.platform == 'linux':
            def descendants(pid):
                children = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
                return [int(child) for child in children] + [nested for child in children for nested in descendants(child)]
            owned_pids = descendants(process.pid)
            assert len(owned_pids) == 4  # Python supervisor, Web, Agent and Worker; no Node BFF.
        if stop_process:
            pids = Path(f'/proc/{process.pid}/task/{process.pid}/children').read_text().split()
            child_pid = next(int(pid) for pid in pids if stop_process.encode() in Path(f'/proc/{pid}/cmdline').read_bytes())
            os.kill(child_pid, signal.SIGTERM)
            while Path(f'/proc/{child_pid}').exists():
                assert time.monotonic() < deadline, 'Child process did not exit'
                time.sleep(.1)
            assert process.poll() is None
            if stop_process == 'app.agent_process':
                with pytest.raises(urllib.error.HTTPError) as failure:
                    opener.open(request, timeout=5)
                assert failure.value.code == 503
                assert json.loads(failure.value.read())['code'] == 'agent_unavailable'
                # Core catalogue and profile remain independent of Agent failure.
                for endpoint in ('/api/routes', '/api/activities', '/api/user-profile'):
                    with opener.open(f'http://127.0.0.1:{port}' + endpoint, timeout=2) as response:
                        assert response.status == 200
                with pytest.raises(urllib.error.HTTPError) as missing:
                    opener.open(f'http://127.0.0.1:{port}/api/chat-sessions', timeout=2)
                assert missing.value.code == 404
            else:
                with opener.open(request, timeout=3) as response:
                    assert response.status == 200
    finally:
        if sys.platform == 'win32':
            process.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            pytest.fail('Launcher did not shut down')
        process.stderr.close()
    assert process.returncode == 0
    assert all(not Path(f'/proc/{pid}').exists() for pid in owned_pids)
    with socket.socket() as sock:
        assert sock.connect_ex(('127.0.0.1', port)) != 0
