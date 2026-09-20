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


class SessionUnavailable(ValueError):
    """A deleted or busy conversation must not silently become a new context."""


@dataclass
class ChatSession:
    session_id: str
    context: AgentContext
    lock: RLock = field(default_factory=RLock)
    responses: OrderedDict[str, tuple[str, dict[str, Any]]] = field(default_factory=OrderedDict)
    touched_at: float = field(default_factory=monotonic)
    persist: Callable[["ChatSession"], None] | None = field(default=None, repr=False)

    kind: str = "chat"
    title: str = "新会话"
    turns: list[dict[str, Any]] = field(default_factory=list)
    created_at: float = field(default_factory=time)
    deleted: bool = False

    def record_turn(self, request_id: str, message: str, response: dict) -> None:
        if any(item["request_id"] == request_id for item in self.turns):
            return
        self.turns.append({"request_id": request_id, "message": message,
                           "response": response, "created_at": time()})
        if self.title == "新会话":
            self.title = message.split("\n", 1)[0][:60]

    def cached_response(self, request_id: str, request_fingerprint: str) -> dict[str, Any] | None:
        if self.deleted:
            raise SessionUnavailable("会话已删除，请新建会话")
        entry = self.responses.get(request_id)
        if entry is not None:
            self.responses.move_to_end(request_id)
            original_fingerprint, response = entry
            if original_fingerprint != request_fingerprint:
                raise ValueError("request_id was already used with a different request payload")
            return response
        return None

    def cache_response(
        self,
        request_id: str,
        request_fingerprint: str,
        response: dict[str, Any],
        *,
        limit: int = 100,
    ) -> None:
        self.responses[request_id] = (request_fingerprint, response)
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
                connection.execute("DELETE FROM route_workflows")
                connection.execute("DELETE FROM chat_session_views")

    def _new_session(self, session_id: str) -> ChatSession:
        with connect_database(self.database) as connection:
            row = connection.execute("SELECT deleted FROM chat_session_views WHERE session_id = ?", (session_id,)).fetchone()
        if row and row["deleted"]:
            raise SessionUnavailable("会话已删除，请新建会话")
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
        try:
            context_data = json.loads(row["context_json"])
            response_data = json.loads(row["responses_json"])
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise SessionUnavailable("会话记录无法读取，请新建会话") from exc
        context = _restore_context(session_id, context_data)
        responses: OrderedDict[str, tuple[str, dict[str, Any]]] = OrderedDict()
        for item in response_data if isinstance(response_data, list) else []:
            if not isinstance(item, dict) or not isinstance(item.get("response"), dict):
                continue
            responses[str(item.get("request_id") or "")] = (
                str(item.get("message") or ""), item["response"],
            )
        session = ChatSession(
            session_id=session_id,
            context=context,
            responses=responses,
            persist=self._persist,
        )

        with connect_database(self.database) as connection:
            view = connection.execute("SELECT * FROM chat_session_views WHERE session_id = ?", (session_id,)).fetchone()
        if view:
            if view["deleted"]:
                raise SessionUnavailable("会话已删除，请新建会话")
            session.kind, session.title = view["kind"], view["title"]
            session.turns = json.loads(view["turns_json"])
            session.created_at = view["created_at"]
        else:
            session.kind = "route_plan" if context.route_messages and not context.messages else "chat"
            # Legacy request caches contain public results, unlike model messages.
            for request_id, (fingerprint, response) in responses.items():
                try:
                    request = json.loads(fingerprint)
                except (ValueError, TypeError):
                    continue
                if isinstance(request, dict) and request.get("message"):
                    if not context.messages:
                        session.kind = request.get("request_mode", session.kind)
                    session.record_turn(request_id, request["message"], response)
            if not session.turns:
                for index, message in enumerate(context.messages or context.route_messages):
                    if message.get("role") in ("user", "assistant") and isinstance(message.get("content"), str):
                        session.turns.append({"request_id": f"legacy-{index}",
                            "message": message["content"] if message["role"] == "user" else "",
                            "response": {"answer": message["content"]} if message["role"] == "assistant" else {}})
            session.title = session.title if session.turns else "历史会话"
            session.turns.insert(0, {"request_id": "legacy-history-notice", "message": "", "response": {
                "answer": "此会话来自旧版本，已恢复可用记录；较早消息可能不完整。原上下文仍保留，需要干净上下文时请新建会话。"}})
            self._persist(session)
        return session

    def create(self, session_id: str, kind: str) -> ChatSession:
        session = self.get_or_create(session_id)
        with session.lock:
            if not session.turns:
                session.kind = kind
            self._persist(session)
        return session

    def detail(self, session_id: str) -> dict:
        with self._lock:
            session = self._sessions.get(session_id) or self._load(session_id)
            if session is None:
                raise KeyError(session_id)
        if not session.lock.acquire(blocking=False):
            raise SessionUnavailable("会话正在处理中，请稍后重试")
        try:
            if session.deleted:
                raise SessionUnavailable("会话已删除")
            return {"schema_version": "agent_session.v1", "session_id": session_id,
                    "kind": session.kind, "title": session.title, "turns": list(session.turns),
                    "route_reference": session.context.route_reference}
        finally:
            session.lock.release()

    def list_sessions(self, kind: str) -> dict:
        with self._lock:
            with connect_database(self.database) as connection:
                legacy = connection.execute("SELECT session_id FROM chat_sessions WHERE session_id NOT IN (SELECT session_id FROM chat_session_views)").fetchall()
            for row in legacy:
                self._load(row["session_id"])
            with connect_database(self.database) as connection:
                rows = connection.execute("SELECT session_id, kind, title, created_at, updated_at FROM chat_session_views WHERE deleted = 0 AND kind = ? ORDER BY updated_at DESC", (kind,)).fetchall()
        return {"schema_version": "agent_session_list.v1", "sessions": [dict(row) for row in rows]}

    def delete(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.get(session_id) or self._load(session_id)
            if session is None:
                raise KeyError(session_id)
            if not session.lock.acquire(blocking=False):
                raise SessionUnavailable("会话正在处理中，暂时不能删除")
            try:
                with connect_database(self.database) as connection:
                    connection.execute("DELETE FROM chat_sessions WHERE session_id = ?", (session_id,))
                    connection.execute("DELETE FROM route_workflows WHERE workspace_id = ?", (f"web-chat:{session_id}",))
                    connection.execute("UPDATE chat_session_views SET deleted = 1, title = '', turns_json = '[]' WHERE session_id = ?", (session_id,))
                session.deleted = True
                self._sessions.pop(session_id, None)
            finally:
                session.lock.release()

    def _persist(self, session: ChatSession) -> None:
        context_json = json.dumps(_context_dict(session.context), ensure_ascii=False, default=str)
        responses_json = json.dumps([
            {"request_id": request_id, "message": message, "response": response}
            for request_id, (message, response) in session.responses.items()
        ], ensure_ascii=False, default=str)
        with connect_database(self.database) as connection:
            if not connection.in_transaction:
                connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT deleted FROM chat_session_views WHERE session_id = ?", (session.session_id,)).fetchone()
            if session.deleted or (row and row["deleted"]):
                raise SessionUnavailable("会话已删除，请新建会话")
            connection.execute("""INSERT INTO chat_session_views(session_id, kind, title, turns_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
                kind=excluded.kind, title=excluded.title, turns_json=excluded.turns_json, updated_at=excluded.updated_at""",
                (session.session_id, session.kind, session.title, json.dumps(session.turns, ensure_ascii=False, default=str), session.created_at, time()))
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
            session = self._sessions[session_id]
            if session.lock.acquire(blocking=False):
                self._sessions.pop(session_id, None)
                session.lock.release()

    def _discard_oldest(self) -> None:
        while len(self._sessions) > self.max_sessions:
            oldest = min(self._sessions.values(), key=lambda item: item.touched_at)
            if not oldest.lock.acquire(blocking=False):
                break
            self._sessions.pop(oldest.session_id, None)
            oldest.lock.release()


def _context_dict(context: AgentContext) -> dict[str, Any]:
    return {
        "messages": context.messages,
        "route_messages": context.route_messages,
        "route_reference": context.route_reference,
        "history_enabled": context.history_enabled,
        "last_tool_result": context.last_tool_result,
        "last_failed_action": context.last_failed_action,
        "last_llm_error": context.last_llm_error,
        "last_used_skills": context.last_used_skills,
        "conversation_used_skills": context.conversation_used_skills,
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
        route_messages=list(payload.get("route_messages") or []),
        route_reference=payload.get("route_reference"),
        history_enabled=bool(payload.get("history_enabled", True)),
        last_tool_result=payload.get("last_tool_result"),
        last_failed_action=payload.get("last_failed_action"),
        last_llm_error=payload.get("last_llm_error"),
        last_used_skills=[str(value) for value in payload.get("last_used_skills") or [] if str(value)],
        conversation_used_skills=[
            str(value) for value in payload.get("conversation_used_skills") or [] if str(value)
        ],
        analysis_navigation=payload.get("analysis_navigation"),
    )
    selected = payload.get("selected_activities") or []
    handles = [ActivityHandle.from_index_entry(item) for item in selected if isinstance(item, dict)]
    context.set_selected_activities(handles, scope=payload.get("selected_activity_range"))
    return context
