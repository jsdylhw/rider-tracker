from __future__ import annotations

import pytest

from app.chat_sessions import ChatSessionStore
from domain.activity.models import ActivityHandle


def test_chat_session_restores_context_and_idempotency_after_restart(tmp_path):
    database = tmp_path / "sessions.db"
    first_store = ChatSessionStore(database=database)
    first = first_store.get_or_create("ride-planning")
    first.context.messages = [{"role": "user", "content": "把路线反转"}]
    first.context.last_failed_action = {"tool_name": "update_route_plan", "args": {"operation": "reverse"}}
    first.context.route_messages = [{"role": "assistant", "content": "从哪里出发？"}]
    first.context.route_reference = {"plan_id": "plan-1", "revision": 2}
    first.context.last_used_skills = ["plan-routes"]
    first.context.conversation_used_skills = ["analyze-activity", "plan-routes"]
    first.context.set_single_activity(ActivityHandle(activity_key="activity-1", fit_path="fits/one.fit"))
    response = {"status": "completed", "answer": "路线已反转"}
    first.cache_response("request-1", "把路线反转", response)

    restored = ChatSessionStore(database=database).get_or_create("ride-planning")

    assert restored.context.messages == first.context.messages
    assert restored.context.route_messages == first.context.route_messages
    assert restored.context.route_reference == {"plan_id": "plan-1", "revision": 2}
    assert restored.context.last_failed_action == first.context.last_failed_action
    assert restored.context.last_used_skills == ["plan-routes"]
    assert restored.context.conversation_used_skills == ["analyze-activity", "plan-routes"]
    assert restored.context.current_activity_key == "activity-1"
    assert restored.cached_response("request-1", "把路线反转") == response
    with pytest.raises(ValueError, match="different request payload"):
        restored.cached_response("request-1", "换一条路线")


def test_chat_session_clear_removes_persisted_state(tmp_path):
    database = tmp_path / "sessions.db"
    store = ChatSessionStore(database=database)
    session = store.get_or_create("session")
    session.context.messages = [{"role": "user", "content": "hello"}]
    session.cache_response("request", "hello", {"answer": "hi"})

    store.clear()
    restored = ChatSessionStore(database=database).get_or_create("session")

    assert restored.context.messages == []
    assert restored.cached_response("request", "hello") is None


def test_visible_history_survives_cache_limit_and_expiry(tmp_path):
    store = ChatSessionStore(database=tmp_path / 'sessions.db', ttl_seconds=-1)
    session = store.create('durable', 'route_plan')
    for number in range(3):
        session.record_turn(str(number), f'地点 {number}', {'answer': '已处理'})
        session.cache_response(str(number), 'payload', {'answer': '已处理'}, limit=1)
    restored = ChatSessionStore(database=store.database, ttl_seconds=-1)
    detail = restored.detail('durable')
    assert len(detail['turns']) == 3
    assert detail['kind'] == 'route_plan'
    assert restored.list_sessions('chat')['sessions'] == []
    assert len(restored.list_sessions('route_plan')['sessions']) == 1


def test_deleted_session_cannot_be_resurrected(tmp_path):
    from app.chat_sessions import SessionUnavailable
    store = ChatSessionStore(database=tmp_path / 'sessions.db')
    old = store.create('deleted', 'chat')
    store.delete('deleted')
    with pytest.raises(SessionUnavailable):
        old.cache_response('late', 'hello', {'answer': 'hi'})
    with pytest.raises(SessionUnavailable):
        store.get_or_create('deleted')
    assert store.list_sessions('chat')['sessions'] == []


def test_busy_session_cannot_be_deleted_or_reloaded_as_empty(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from app.chat_sessions import SessionUnavailable
    store = ChatSessionStore(database=tmp_path / 'sessions.db', ttl_seconds=-1)
    session = store.create('running', 'chat')
    with session.lock, ThreadPoolExecutor(max_workers=1) as worker:
        assert worker.submit(store.get_or_create, 'running').result() is session
        for operation in (store.delete, store.detail):
            with pytest.raises(SessionUnavailable, match='正在处理'):
                worker.submit(operation, 'running').result()
    assert store.detail('running')['session_id'] == 'running'


def test_legacy_session_is_migrated_without_expiring_old_history(tmp_path):
    import json
    import sqlite3
    database = tmp_path / 'legacy.db'
    with sqlite3.connect(database) as connection:
        connection.execute('CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, responses_json TEXT NOT NULL, updated_at REAL NOT NULL)')
        connection.execute('INSERT INTO chat_sessions VALUES (?, ?, ?, ?)', (
            'legacy', json.dumps({'route_messages': [{'role': 'user', 'content': '京都'}]}),
            json.dumps([{'request_id': 'one', 'message': json.dumps({'message': '京都', 'request_mode': 'route_plan'}),
                         'response': {'answer': '旧路线', 'status': 'completed'}}]), 1,
        ))
        connection.execute('PRAGMA user_version = 12')
    store = ChatSessionStore(database=database, ttl_seconds=1)
    detail = store.detail('legacy')
    assert detail['kind'] == 'route_plan'
    assert '旧版本' in detail['turns'][0]['response']['answer']
    assert detail['turns'][1]['message'] == '京都'
    assert store.get_or_create('legacy').context.route_messages[0]['content'] == '京都'
    assert len(store.list_sessions('route_plan')['sessions']) == 1
