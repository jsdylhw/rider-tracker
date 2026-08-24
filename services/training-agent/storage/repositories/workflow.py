"""Repository and process lock for persisted workflow runs."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

DEFAULT_WORKFLOW_DIRECTORY = Path("data") / "runs"


class WorkflowLockError(RuntimeError):
    """另一个进程正在推进同一个持久化 Run。"""


def workflow_path(workflow_id: str, *, directory: str | Path | None = None) -> Path:
    """返回受限的 workflow 文件路径，禁止路径穿越。"""
    workflow_id = str(workflow_id).strip()
    if not workflow_id or any(value in workflow_id for value in ("/", "\\", "..")):
        raise ValueError("invalid workflow_id")
    root = Path(directory) if directory is not None else DEFAULT_WORKFLOW_DIRECTORY
    return root / f"{workflow_id}.json"


def workflow_lock_path(workflow_id: str, *, directory: str | Path | None = None) -> Path:
    """返回同一 workflow 的进程级排他锁文件路径。"""
    target = workflow_path(workflow_id, directory=directory)
    return target.with_name(f".{target.stem}.lock")


@contextmanager
def acquire_workflow_lock(
    workflow_id: str,
    *,
    directory: str | Path | None = None,
) -> Iterator[None]:
    """获取非阻塞的跨进程排他锁。

    锁由 OS 文件描述符持有；即使 lock 文件保留，进程崩溃也会释放锁，下一次
    执行才能安全地判断 ``running`` 是遗留状态而非另一个活跃执行器。
    """
    path = workflow_lock_path(workflow_id, directory=directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        _ensure_lock_byte(handle)
        _lock_nonblocking(handle)
    except OSError as exc:
        handle.close()
        raise WorkflowLockError(f"workflow {workflow_id} is already executing") from exc
    try:
        yield
    finally:
        try:
            _unlock(handle)
        finally:
            handle.close()


def save_workflow(run: dict[str, Any], *, directory: str | Path | None = None) -> Path:
    """原子写入完整运行快照。"""
    workflow_id = str(run.get("workflow_id") or "")
    target = workflow_path(workflow_id, directory=directory)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(run, handle, ensure_ascii=False, indent=2, default=str)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return target


def load_workflow(workflow_id: str, *, directory: str | Path | None = None) -> dict[str, Any] | None:
    """读取单个运行快照；不存在或损坏时返回 None。"""
    try:
        payload = json.loads(workflow_path(workflow_id, directory=directory).read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _ensure_lock_byte(handle: Any) -> None:
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
        os.fsync(handle.fileno())
    handle.seek(0)


def _lock_nonblocking(handle: Any) -> None:
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(handle: Any) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
