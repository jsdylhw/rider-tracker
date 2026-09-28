"""Existing Agent behavior behind Browser URLs; never invokes a real model."""
import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from tests.test_api import _prepare_api
from app.agent_browser import normalize_chat, normalize_command


@pytest.fixture
def browser(tmp_path, monkeypatch):
    api, _, _ = _prepare_api(tmp_path, monkeypatch)
    from app.browser import create_browser_app
    return api, TestClient(create_browser_app())


def test_browser_session_lifecycle(browser):
    _, client = browser
    assert client.get('/api/agent/health').json()['ok'] is True
    created = client.post('/api/agent/sessions', json={'session_id': 'edge-test', 'kind': 'chat'})
    assert created.status_code == 200
    assert created.json()['result']['session_id'] == 'edge-test'
    assert client.get('/api/agent/sessions').json()['result']['sessions'][0]['session_id'] == 'edge-test'
    assert client.get('/api/agent/sessions/edge-test').json()['result']['session_id'] == 'edge-test'
    assert client.delete('/api/agent/sessions/edge-test').json()['ok'] is True
    assert client.get('/api/agent/sessions/edge-test').status_code == 404


def test_chat_json_and_stream_share_existing_execution(browser, monkeypatch):
    api, client = browser
    calls = []
    def turn(body, request, **kwargs):
        calls.append(body)
        if kwargs.get('on_progress'):
            kwargs['on_progress']({'stage': 'test', 'message': 'Working'})
        return {'answer': 'Done'}
    monkeypatch.setattr(api, '_chat_turn', turn)
    body = {'session_id': 's', 'request_id': 'r', 'message': '  Hello  '}
    assert client.post('/api/agent/chat', json=body).json() == {'ok': True, 'result': {'answer': 'Done'}}
    response = client.post('/api/agent/chat', json=body, headers={'Accept': 'application/x-ndjson'})
    events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    assert [event['type'] for event in events] == ['progress', 'result']
    assert events[-1]['schema_version'] == 'agent_stream.v1'
    assert all(call.message == 'Hello' for call in calls)


def test_command_preserves_conflict_and_invalid_requests_do_not_execute(browser, monkeypatch):
    api, client = browser
    calls = []
    def conflict(body, request):
        calls.append(body)
        raise HTTPException(409, {'code': 'route_revision_conflict', 'message': 'changed'})
    monkeypatch.setattr(api, 'route_plan_command_endpoint', conflict)
    body = {'session_id': 's', 'request_id': 'r', 'operation': 'reverse', 'plan_id': 'plan'}
    assert client.post('/api/agent/route-plans/command', json=body).status_code == 400
    assert calls == []
    response = client.post('/api/agent/route-plans/command', json={**body, 'expected_revision': 1})
    assert response.status_code == 409
    assert response.json() == {'ok': False, 'error': 'changed'}


def test_stream_capability_failure_and_token_denial(browser, monkeypatch):
    api, client = browser
    body = {'session_id': 's', 'request_id': 'r', 'message': 'Hello'}
    headers = {'Accept': 'application/x-ndjson'}
    monkeypatch.setattr(api, '_require_llm_capability', lambda *args: (_ for _ in ()).throw(HTTPException(503, 'unavailable')))
    response = client.post('/api/agent/chat', json=body, headers=headers)
    assert response.status_code == 200
    assert json.loads(response.text)['type'] == 'error'
    monkeypatch.setattr(api, 'load_config', lambda: {'web_api_token': 'secret'})
    assert client.post('/api/agent/chat', json=body, headers=headers).status_code == 401


@pytest.mark.parametrize('change', [{'route_action': 'create'}, {'route_options': {'include_ascent': 'false'}}, {'route_reference': {}}, {'request_mode': 'route_plan'}])
def test_chat_invalid_semantics_are_rejected(change):
    with pytest.raises(ValueError):
        normalize_chat({'session_id': 's', 'request_id': 'r', 'message': 'Hello', **change})


def test_command_normalization_keeps_existing_bounds():
    result = normalize_command({'session_id': 's', 'request_id': 'r', 'operation': 'explore_segments', 'expected_revision': 1, 'corridor_km': 99, 'max_segments': 4.5})
    assert result['corridor_km'] == 20
    assert result['max_segments'] == 5


def test_unexpected_pre_stream_failure_has_one_terminal_event(browser, monkeypatch):
    api, client = browser
    def failed(*args):
        raise RuntimeError('private diagnostic fixture')
    monkeypatch.setattr(api, 'chat_endpoint', failed)
    body = {'session_id': 's', 'request_id': 'r', 'message': 'Hello'}
    response = client.post('/api/agent/chat', json=body, headers={'Accept': 'application/x-ndjson'})
    assert response.status_code == 200
    assert response.headers['x-accel-buffering'] == 'no'
    events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    assert events == [{'schema_version': 'agent_stream.v1', 'type': 'error', 'message': 'Backend request failed.'}]
    response = client.post('/api/agent/chat', json=body)
    assert response.status_code == 500
    assert response.json()['ok'] is False
