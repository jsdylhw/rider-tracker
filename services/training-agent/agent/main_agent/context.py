"""Main Agent 的运行期状态.

AgentContext 是一次 Main Agent 执行内共享的状态容器.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from domain.activity.models import ActivityHandle


@dataclass
class AgentContext:
    """一次 Main Agent 运行内共享的可变状态.

    活动定位:
      selected_handles       — 新接口: list[ActivityHandle]
      selected_activities    — 工具层 dict 视图,与 handles 保持同步
      selected_activity_range — 活动范围元数据

    单活动快捷字段:
      current_fit_file / current_activity_key

    内部缓存:
      last_failed_action / parsed / history_before
    """

    session_id: str
    # session_id traces one process; workspace_id restores analysis focus across processes.
    workspace_id: str | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)
    history_enabled: bool = True
    last_tool_result: dict[str, Any] | None = None
    last_failed_action: dict[str, Any] | None = None
    last_llm_error: dict[str, Any] | None = None
    # Per-turn, compact tool trace used by the readable Markdown log.  This is
    # diagnostic metadata only; it is not persisted as conversation state.
    execution_trace: list[dict[str, Any]] = field(default_factory=list)

    # 当前用户轮次激活的领域 Skill；每个新请求都会重新选择，不跨轮授权。
    active_skill_id: str | None = None
    # Skill history is diagnostic/routing context only. Tool authorization is
    # still owned exclusively by the turn-scoped active_skill_id.
    last_used_skills: list[str] = field(default_factory=list)
    conversation_used_skills: list[str] = field(default_factory=list)
    active_skill_confidence: float = 0.0
    active_skill_reason: str | None = None
    pending_skill_reference: str | None = None

    # In-memory projection of the persisted activity/segment navigation stack.
    analysis_navigation: dict[str, Any] | None = None

    # 活动定位
    selected_handles: list[ActivityHandle] = field(default_factory=list)
    selected_activities: list[dict[str, Any]] = field(default_factory=list)
    selected_activity_range: dict[str, Any] | None = None

    # 单活动快捷字段
    current_fit_file: Path | None = None
    current_activity_key: str | None = None

    # 内部缓存
    parsed: dict[str, Any] | None = None
    history_before: dict[str, Any] | None = None

    # -- 更新方法 --------------------------------------------------------

    def set_selected_activities(
        self,
        handles: list[ActivityHandle],
        *,
        scope: dict[str, Any] | None = None,
    ) -> None:
        """设置当前选中的活动(新旧字段同步)."""
        self.selected_handles = handles
        self.selected_activities = [h.to_dict() for h in handles]
        if scope is not None:
            self.selected_activity_range = scope
        if len(handles) == 1:
            self._sync_single_activity_fields(handles[0])
        else:
            # A collection must not inherit a stale single-activity shortcut.
            self.current_fit_file = None
            self.current_activity_key = None

    def set_single_activity(self, handle: ActivityHandle) -> None:
        """设置单个选中活动."""
        self.set_selected_activities([handle], scope={"type": "single_activity"})

    def clear_activities(self) -> None:
        """清空活动选择."""
        self.selected_handles = []
        self.selected_activities = []
        self.selected_activity_range = None
        self.current_fit_file = None
        self.current_activity_key = None

    # -- 内部 ------------------------------------------------------------

    def _sync_single_activity_fields(self, handle: ActivityHandle) -> None:
        # Never retain the previous activity's FIT path when the newly selected
        # catalogue row has no local file.  The activity ID and FIT shortcut
        # must always describe the same immutable activity.
        self.current_fit_file = handle.fit_path_obj
        self.current_activity_key = handle.activity_key
