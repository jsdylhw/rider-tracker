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
    first.context.last_used_skills = ["plan-routes"]
    first.context.conversation_used_skills = ["analyze-activity", "plan-routes"]
    first.context.set_single_activity(ActivityHandle(activity_key="activity-1", fit_path="fits/one.fit"))
    response = {"status": "completed", "answer": "路线已反转"}
    first.cache_response("request-1", "把路线反转", response)

    restored = ChatSessionStore(database=database).get_or_create("ride-planning")

    assert restored.context.messages == first.context.messages
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
