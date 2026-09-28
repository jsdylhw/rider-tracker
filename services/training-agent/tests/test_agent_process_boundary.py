"""Private transport, session ownership and no-replay fault boundaries."""
import json
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from app.agent_process import create_agent_process_app
from app.agent_proxy import create_agent_proxy_router
from tests.test_api import _prepare_api


def proxy_client(api, transport):
    app = FastAPI()
    app.include_router(create_agent_proxy_router(api, 'http://127.0.0.1:9999', 'private-token', transport=transport))
    return TestClient(app)


def test_private_token_and_session_roundtrip(tmp_path, monkeypatch):
    api, _, _ = _prepare_api(tmp_path, monkeypatch)
    monkeypatch.setattr(api, 'load_config', lambda: {'web_api_token': 'web-token'})
    internal = create_agent_process_app('private-token')
    direct = TestClient(internal)
    assert direct.get('/health').status_code == 401
    assert direct.get('/health', headers={'X-API-Token': 'web-token'}).status_code == 401
    assert direct.get('/health', headers={'X-Rider-Agent-Token': 'private-token'}).status_code == 200
    client = proxy_client(api, httpx.ASGITransport(app=internal))
    assert client.get('/api/agent/sessions', headers={'X-Rider-Agent-Token': 'private-token'}).status_code == 401
    client.headers['X-API-Token'] = 'web-token'
    result = client.post('/api/agent/sessions', json={'session_id': 'isolated', 'kind': 'chat'})
    assert result.status_code == 200, result.text
    assert client.get('/api/agent/sessions/isolated').json()['result']['session_id'] == 'isolated'
    assert client.delete('/api/agent/sessions/isolated').json()['ok'] is True
    assert client.get('/api/agent/sessions/isolated').status_code == 404


@pytest.mark.parametrize('streaming', [False, True])
def test_disconnect_is_one_attempt_and_explicit_failure(tmp_path, monkeypatch, streaming):
    api, _, _ = _prepare_api(tmp_path, monkeypatch)
    calls = []
    def disconnected(request):
        calls.append(request)
        assert request.headers['X-Rider-Agent-Token'] == 'private-token'
        assert 'cookie' not in request.headers
        raise httpx.ReadError('fixture connection lost after write')
    client = proxy_client(api, httpx.MockTransport(disconnected))
    response = client.post('/api/agent/chat', json={'session_id': 's', 'request_id': 'r', 'message': 'test',
        'request_mode': 'route_plan', 'route_action': 'create'},
        headers={'Accept': 'application/x-ndjson' if streaming else 'application/json', 'Cookie': 'browser=private'})
    assert len(calls) == 1
    if streaming:
        assert response.status_code == 200
        event = json.loads(response.text)
        assert event['type'] == 'error' and event['schema_version'] == 'route_stream.v1'
    else:
        assert response.status_code == 503
        assert response.json()['code'] == 'agent_unavailable'


@pytest.mark.parametrize('terminal', [False, True])
def test_stream_preserves_progress_and_checks_terminal_result(tmp_path, monkeypatch, terminal):
    api, _, _ = _prepare_api(tmp_path, monkeypatch)
    progress = {'schema_version': 'agent_stream.v1', 'type': 'progress', 'message': 'working'}
    result = {'schema_version': 'agent_stream.v1', 'type': 'result', 'result': {'answer': 'done'}}
    payload = json.dumps(progress) + '\n\n' + (json.dumps(result) + '\n' if terminal else '')
    client = proxy_client(api, httpx.MockTransport(lambda r: httpx.Response(200,
        headers={'Content-Type': 'application/x-ndjson'}, content=payload)))
    response = client.post('/api/agent/chat', json={'message': 'test'}, headers={'Accept': 'application/x-ndjson'})
    events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    assert events[0] == progress
    assert len(events) == 2
    assert events[-1] == result if terminal else events[-1]['type'] == 'error'


def test_isolated_browser_does_not_expose_local_execution_aliases(tmp_path, monkeypatch):
    api, _, _ = _prepare_api(tmp_path, monkeypatch)
    from app.browser import create_browser_app
    client = TestClient(create_browser_app(agent_url='http://127.0.0.1:9999', agent_token='private-token'))
    for method, path in [('post', '/api/chat'), ('get', '/api/chat-sessions'), ('post', '/api/route-plans/command')]:
        assert getattr(client, method)(path).status_code == 404
    assert client.get('/healthz').status_code == 200
    assert client.get('/api/routes').status_code == 200
