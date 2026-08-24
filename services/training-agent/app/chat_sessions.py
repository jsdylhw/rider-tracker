"""Durable session store for the synchronous Chat API."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
import json
from pathlib import Path
from threading import RLock
from time import monotonic, time
from typing import Any, Callable

from agent.main_agent.context import AgentContext
from domain.activity.models import ActivityHandle
from storage.database import connect_database


@dataclass
class ChatSession:
    session_id: str
    context: AgentContext
    lock: RLock = field(default_factory=RLock)
    responses: OrderedDict[str, tuple[str, dict[str, Any]]] = field(default_factory=OrderedDict)
    touched_at: float = field(default_factory=monotonic)
    persist: Callable[["ChatSession"], None] | None = field(default=None, repr=False)

    def cached_response(self, request_id: str, message: str) -> dict[str, Any] | None:
        entry = self.responses.get(request_id)
        if entry is not None:
            self.responses.move_to_end(request_id)
            original_message, response = entry
            if original_message != message:
                raise ValueError("request_id was already used with a different message")
            return response
        return None

    def cache_response(
        self,
        request_id: str,
        message: str,
        response: dict[str, Any],
        *,
        limit: int = 100,
    ) -> None:
        self.responses[request_id] = (message, response)
        self.responses.move_to_end(request_id)
        while len(self.responses) > limit:
            self.responses.popitem(last=False)
        if self.persist is not None:
            self.persist(self)


class ChatSessionStore:
    """Own chat contexts, serialize turns, and restore them from SQLite."""

    def __init__(
        self,
        *,
        ttl_seconds: int = 6 * 60 * 60,
        max_sessions: int = 256,
        database: str | Path | None = None,
    ):
        self.ttl_seconds = ttl_seconds
        self.max_sessions = max_sessions
        self.database = database
        self._lock = RLock()
        self._sessions: dict[str, ChatSession] = {}

    def get_or_create(self, session_id: str) -> ChatSession:
        with self._lock:
            now = monotonic()
            self._discard_expired(now)
            session = self._sessions.get(session_id)
            if session is None:
                session = self._load(session_id) or self._new_session(session_id)
                self._sessions[session_id] = session
                self._discard_oldest()
            session.touched_at = now
            return session

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()
            with connect_database(self.database) as connection:
                connection.execute("DELETE FROM chat_sessions")

    def _new_session(self, session_id: str) -> ChatSession:
        return ChatSession(
            session_id=session_id,
            context=AgentContext(
                session_id=f"web-chat:{session_id}",
                workspace_id=f"web-chat:{session_id}",
            ),
            persist=self._persist,
        )

    def _load(self, session_id: str) -> ChatSession | None:
        with connect_database(self.database) as connection:
            row = connection.execute(
                "SELECT context_json, responses_json, updated_at FROM chat_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                return None
            if time() - float(row["updated_at"]) > self.ttl_seconds:
                connection.execute("DELETE FROM chat_sessions WHERE session_id = ?", (session_id,))
                return None
        try:
            context_data = json.loads(row["context_json"])
            response_data = json.loads(row["responses_json"])
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
        context = _restore_context(session_id, context_data)
        responses: OrderedDict[str, tuple[str, dict[str, Any]]] = OrderedDict()
        for item in response_data if isinstance(response_data, list) else []:
            if not isinstance(item, dict) or not isinstance(item.get("response"), dict):
                continue
            responses[str(item.get("request_id") or "")] = (
                str(item.get("message") or ""), item["response"],
            )
        return ChatSession(
            session_id=session_id,
            context=context,
            responses=responses,
            persist=self._persist,
        )

    def _persist(self, session: ChatSession) -> None:
        context_json = json.dumps(_context_dict(session.context), ensure_ascii=False, default=str)
        responses_json = json.dumps([
            {"request_id": request_id, "message": message, "response": response}
            for request_id, (message, response) in session.responses.items()
        ], ensure_ascii=False, default=str)
        with connect_database(self.database) as connection:
            connection.execute(
                """
                INSERT INTO chat_sessions(session_id, context_json, responses_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    context_json = excluded.context_json,
                    responses_json = excluded.responses_json,
                    updated_at = excluded.updated_at
                """,
                (session.session_id, context_json, responses_json, time()),
            )

    def _discard_expired(self, now: float) -> None:
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if now - session.touched_at > self.ttl_seconds
        ]
        for session_id in expired:
            self._sessions.pop(session_id, None)

    def _discard_oldest(self) -> None:
        while len(self._sessions) > self.max_sessions:
            oldest = min(self._sessions.values(), key=lambda item: item.touched_at)
            self._sessions.pop(oldest.session_id, None)


def _context_dict(context: AgentContext) -> dict[str, Any]:
    return {
        "messages": context.messages,
        "history_enabled": context.history_enabled,
        "last_tool_result": context.last_tool_result,
        "last_failed_action": context.last_failed_action,
        "last_llm_error": context.last_llm_error,
        "analysis_navigation": context.analysis_navigation,
        "selected_activities": context.selected_activities,
        "selected_activity_range": context.selected_activity_range,
    }


def _restore_context(session_id: str, data: Any) -> AgentContext:
    payload = data if isinstance(data, dict) else {}
    context = AgentContext(
        session_id=f"web-chat:{session_id}",
        workspace_id=f"web-chat:{session_id}",
        messages=list(payload.get("messages") or []),
        history_enabled=bool(payload.get("history_enabled", True)),
        last_tool_result=payload.get("last_tool_result"),
        last_failed_action=payload.get("last_failed_action"),
        last_llm_error=payload.get("last_llm_error"),
        analysis_navigation=payload.get("analysis_navigation"),
    )
    selected = payload.get("selected_activities") or []
    handles = [ActivityHandle.from_index_entry(item) for item in selected if isinstance(item, dict)]
    context.set_selected_activities(handles, scope=payload.get("selected_activity_range"))
    return context
