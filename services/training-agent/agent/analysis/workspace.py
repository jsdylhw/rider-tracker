"""Persisted navigation adapter for the main agent's analysis workspace."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from domain.activity.models import ActivityHandle
from domain.contracts.schemas import ANALYSIS_WORKSPACE_V1
from agent.main_agent.context import AgentContext
from storage.repositories.activity import ActivityStore
from storage.repositories.analysis import AnalysisStore


class AnalysisNavigationService:
    """Keep concrete collection order and current focus across CLI processes."""

    def __init__(self, path: str | Path | None = None):
        self.path = path
        self.store = AnalysisStore(path)
        self.activities = ActivityStore(path)

    def load_into_context(self, context: AgentContext) -> dict[str, Any]:
        workspace_id = context.workspace_id or "default"
        context.workspace_id = workspace_id
        navigation = self.store.load_navigation(workspace_id) or _empty_navigation(workspace_id)
        navigation = self._prune_missing_activities(navigation)
        context.analysis_navigation = navigation
        self._sync_context(context, navigation)
        return navigation

    def replace_activities(
        self,
        context: AgentContext,
        activities: list[dict[str, Any]],
        *,
        scope: dict[str, Any] | None,
    ) -> dict[str, Any]:
        navigation = self._navigation(context)
        activity_ids = [str(item.get("activity_key") or "") for item in activities if item.get("activity_key")]
        focus = _activity_focus(activity_ids)
        root_scope = {**focus, "selection": deepcopy(scope or {})}
        navigation.update({"root_scope": root_scope, "focus_stack": [focus]})
        saved = self.store.save_navigation(navigation)
        context.analysis_navigation = saved
        # Loading an empty workspace may clear the context before this new
        # root is installed.  Always project the persisted selection back so
        # context and SQLite navigation change atomically.
        self._sync_context(context, saved)
        return saved

    def push_segments(
        self,
        context: AgentContext,
        segments: list[dict[str, Any]],
        *,
        selected_ordinal: int | None = None,
    ) -> dict[str, Any]:
        navigation = self._navigation(context)
        stack = list(navigation.get("focus_stack") or [])
        segment_ids = [str(item.get("segment_id") or "") for item in segments if item.get("segment_id")]
        stack.append({"type": "segment_set", "ids": segment_ids, "items": deepcopy(segments)})
        if selected_ordinal is not None and 1 <= selected_ordinal <= len(segments):
            stack.append({"type": "segment", "id": segment_ids[selected_ordinal - 1], "item": deepcopy(segments[selected_ordinal - 1])})
        navigation["focus_stack"] = stack
        saved = self.store.save_navigation(navigation)
        context.analysis_navigation = saved
        return saved

    def navigate(self, context: AgentContext, *, action: str, ordinal: int | None = None) -> dict[str, Any]:
        navigation = self._navigation(context)
        stack = list(navigation.get("focus_stack") or [])
        if action == "back":
            if len(stack) > 1:
                stack.pop()
        elif action == "root":
            root = navigation.get("root_scope")
            stack = [_focus_without_selection(root)] if isinstance(root, dict) and root.get("type") else []
        elif action == "select":
            container = _nearest_collection(stack)
            ids = list(container.get("ids") or []) if container else []
            if ordinal is None or ordinal < 1 or ordinal > len(ids):
                raise ValueError(f"ordinal must be between 1 and {len(ids)}")
            selected_id = str(ids[ordinal - 1])
            if container.get("type") == "activity_set":
                stack.append({"type": "activity", "id": selected_id})
            else:
                item = next(
                    (item for item in container.get("items") or [] if str(item.get("segment_id")) == selected_id),
                    None,
                )
                stack.append({"type": "segment", "id": selected_id, "item": deepcopy(item)})
        elif action != "current":
            raise ValueError(f"unsupported navigation action: {action}")
        navigation["focus_stack"] = stack
        saved = self.store.save_navigation(navigation)
        context.analysis_navigation = saved
        self._sync_context(context, saved)
        return saved

    def current_focus(self, context: AgentContext) -> dict[str, Any] | None:
        stack = list(self._navigation(context).get("focus_stack") or [])
        return deepcopy(stack[-1]) if stack else None

    def nearest_activity_ids(self, context: AgentContext) -> list[str]:
        stack = list(self._navigation(context).get("focus_stack") or [])
        for focus in reversed(stack):
            if focus.get("type") == "activity":
                return [str(focus.get("id"))]
            if focus.get("type") == "activity_set":
                return [str(value) for value in focus.get("ids") or []]
        return []

    def current_segments(self, context: AgentContext) -> list[dict[str, Any]]:
        stack = list(self._navigation(context).get("focus_stack") or [])
        for focus in reversed(stack):
            if focus.get("type") == "segment" and isinstance(focus.get("item"), dict):
                return [deepcopy(focus["item"])]
            if focus.get("type") == "segment_set":
                return [deepcopy(item) for item in focus.get("items") or [] if isinstance(item, dict)]
        return []

    def set_last_result(self, context: AgentContext, result_id: str) -> dict[str, Any]:
        navigation = self._navigation(context)
        navigation["last_result_id"] = str(result_id)
        saved = self.store.save_navigation(navigation)
        context.analysis_navigation = saved
        return saved

    def _navigation(self, context: AgentContext) -> dict[str, Any]:
        if not isinstance(context.analysis_navigation, dict):
            return self.load_into_context(context)
        return deepcopy(context.analysis_navigation)

    def _sync_context(self, context: AgentContext, navigation: dict[str, Any]) -> None:
        activity_ids = self.nearest_activity_ids(context)
        activities = [self.activities.get_activity(value) for value in activity_ids]
        handles = [ActivityHandle.from_index_entry(item) for item in activities if isinstance(item, dict)]
        if handles:
            context.set_selected_activities(handles, scope=(navigation.get("root_scope") or {}).get("selection"))
        else:
            context.clear_activities()

    def _prune_missing_activities(self, navigation: dict[str, Any]) -> dict[str, Any]:
        root = navigation.get("root_scope")
        if not isinstance(root, dict):
            return navigation
        original = (
            [root.get("id")] if root.get("type") == "activity" and root.get("id")
            else list(root.get("ids") or [])
        )
        valid = [value for value in original if self.activities.get_activity(str(value))]
        if valid == original:
            return navigation
        if not valid:
            return _empty_navigation(str(navigation.get("workspace_id") or "default"))
        if len(valid) == 1:
            root = {key: value for key, value in root.items() if key != "ids"}
            root.update({"type": "activity", "id": valid[0]})
        else:
            root = {key: value for key, value in root.items() if key != "id"}
            root.update({"type": "activity_set", "ids": valid})
        navigation = {**navigation, "root_scope": root, "focus_stack": [_focus_without_selection(root)]}
        return self.store.save_navigation(navigation)


def _empty_navigation(workspace_id: str) -> dict[str, Any]:
    return {
        "schema_version": ANALYSIS_WORKSPACE_V1,
        "workspace_id": workspace_id,
        "root_scope": None,
        "focus_stack": [],
        "last_result_id": None,
        "revision": 0,
    }


def _activity_focus(activity_ids: list[str]) -> dict[str, Any]:
    if len(activity_ids) == 1:
        return {"type": "activity", "id": activity_ids[0]}
    return {"type": "activity_set", "ids": list(activity_ids)}


def _focus_without_selection(root: dict[str, Any]) -> dict[str, Any]:
    return {key: deepcopy(value) for key, value in root.items() if key != "selection"}


def _nearest_collection(stack: list[dict[str, Any]]) -> dict[str, Any] | None:
    for focus in reversed(stack):
        if focus.get("type") in {"activity_set", "segment_set"}:
            return focus
    return None
