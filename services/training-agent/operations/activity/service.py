"""活动领域的具体操作服务：同步、分析和上传。

这里编排 integrations、storage 与分析 Agent 的实现细节；不读取或修改 AgentContext，也不
负责持久化工作流状态。CLI、聊天 handler 和 ActivityRun 都通过清晰的操作
入口调用它。
"""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import requests

MAX_SYNC_COUNT = 20


def check_garmin_connection() -> dict[str, Any]:
    """验证 Garmin 凭据，并返回最新一条远端活动（不下载文件）。"""
    from settings import load_config
    from integrations.garmin import build_downloader

    downloader = build_downloader(load_config())
    downloader.login()
    activities = downloader.list_activities(1)
    return {"status": "connected", "latest_activity": activities[0] if activities else None}


def sync_garmin_activities_tool(
    count: int = 5,
    *,
    force_download: bool = False,
) -> dict[str, Any]:
    """从 Garmin 中国区下载最近 N 条活动的 FIT 文件,自动跳过已下载的。

    Args:
        count: 下载最近几条活动 [1, 20],默认 5。

    Returns:
        dict: {fit_dir, total, downloaded, skipped, failed, *_items}
    """
    if isinstance(count, bool) or not isinstance(count, int) or count <= 0 or count > MAX_SYNC_COUNT:
        raise ValueError(f"count must be an integer between 1 and {MAX_SYNC_COUNT}")

    from settings import cfg_get, load_config, resolve_project_path
    from integrations.garmin import (
        DEFAULT_OUTPUT_DIR,
        build_downloader,
        existing_fit_paths,
        save_original_as_fit,
    )

    config = load_config()
    output_dir = resolve_project_path(cfg_get(config, "output_dir", DEFAULT_OUTPUT_DIR))
    downloader = build_downloader(config)
    downloader.login()
    activities = downloader.list_activities(count)

    downloaded: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    indexed: list[dict[str, Any]] = []
    index_errors: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    for activity in activities:
        activity_id = activity.get("activityId")
        try:
            existing = existing_fit_paths(output_dir, activity)
            if existing and not force_download:
                _index_fit_paths(existing, activity_id=activity_id, indexed=indexed, errors=index_errors)
                skipped.append({
                    "activity_id": activity_id,
                    "name": activity.get("activityName"),
                    "start_time": activity.get("startTimeLocal"),
                    "paths": [str(p) for p in existing],
                })
                continue

            raw_bytes = downloader.download_original(activity_id)
            saved = _validate_then_save_original(
                raw_bytes, output_dir, activity, save_original_as_fit=save_original_as_fit,
            )
            _index_fit_paths(saved, activity_id=activity_id, indexed=indexed, errors=index_errors)
            downloaded.append({
                "activity_id": activity_id,
                "name": activity.get("activityName"),
                "start_time": activity.get("startTimeLocal"),
                "paths": [str(p) for p in saved],
            })
        except Exception as exc:
            failed.append({
                "activity_id": activity_id,
                "name": activity.get("activityName"),
                "start_time": activity.get("startTimeLocal"),
                "error": type(exc).__name__,
                "message": str(exc),
            })

    return {
        "fit_dir": str(output_dir),
        "total": len(activities),
        "downloaded": len(downloaded),
        "skipped": len(skipped),
        "failed": len(failed),
        "force_download": bool(force_download),
        "downloaded_items": downloaded,
        "skipped_items": skipped,
        "failed_items": failed,
        "indexed": len(indexed),
        "indexed_items": indexed,
        "index_errors": index_errors,
    }


def _validate_then_save_original(
    raw_bytes: bytes,
    output_dir: Path,
    activity: dict[str, Any],
    *,
    save_original_as_fit,
) -> list[Path]:
    """Parse a staged Garmin ORIGINAL before replacing any visible FIT file."""
    from services.activity.catalog import parse_fit

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".garmin-refresh-", dir=output_dir.parent) as temporary:
        staged = save_original_as_fit(raw_bytes, Path(temporary), activity)
        for path in staged:
            parse_fit(path)
    return save_original_as_fit(raw_bytes, output_dir, activity)


def _index_fit_paths(
    paths: list[Path],
    *,
    activity_id: Any,
    indexed: list[dict[str, Any]],
    errors: list[dict[str, Any]],
) -> None:
    from services.activity.catalog import upsert_activity_from_fit

    for path in paths:
        try:
            entry = upsert_activity_from_fit(
                path,
                source="garmin_cn",
                source_activity_id=str(activity_id) if activity_id is not None else None,
            )
        except Exception as exc:
            errors.append({
                "path": str(path),
                "activity_id": activity_id,
                "error": type(exc).__name__,
                "message": str(exc),
            })
            continue
        indexed.append({
            "path": str(path),
            "activity_id": activity_id,
            "activity_key": entry.get("activity_key"),
            "sport_type": entry.get("sport_type"),
            "start_time_local": entry.get("start_time_local"),
        })


def analyze_fit_document(
    fit_path: str,
    *,
    use_history: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    """生成单个 FIT 的完整分析文档，供 API 等界面调用。"""
    from agent.analysis.agent import analyze_fit_file

    return analyze_fit_file(fit_path, use_history=use_history, force=force)


def analyze_fit_file_tool(
    fit_path: str,
    *,
    force: bool = False,
    use_history: bool = False,
) -> dict[str, Any]:
    """对指定 FIT 文件运行本地 LLM 分析(hidden tool loop),返回精简摘要。

    Args:
        fit_path: .fit 文件路径。
        force: 强制重新分析(即使已有缓存)。

    Returns:
        dict: 精简活动元数据与报告正文,供 main_agent 直接展示.
    """
    result = analyze_fit_document(fit_path, use_history=use_history, force=force)
    fit_summary = result.get("fit_summary") or {}
    from fit.analysis.stats import _meters_to_km, _seconds_to_minutes

    return {
        "activity_key": result.get("activity_key"),
        "fit_path": result.get("fit_path"),
        "sport_type": fit_summary.get("sport_type"),
        "start_time_local": fit_summary.get("start_time_local"),
        "duration_min": _seconds_to_minutes(fit_summary.get("duration_s")),
        "distance_km": _meters_to_km(fit_summary.get("distance_m")),
        "markdown_report": result.get("markdown_report"),
        "strava_summary": result.get("strava_summary"),
        "analysis_summary": result.get("analysis_summary") if isinstance(result.get("analysis_summary"), dict) else {},
        "activity_metrics": result.get("activity_metrics") if isinstance(result.get("activity_metrics"), dict) else {},
        "model": result.get("model"),
        "status": result.get("status"),
    }


def upload_to_strava_tool(fit_path: str, *, force: bool = False) -> dict[str, Any]:
    """上传 FIT 文件到 Strava 并写入描述。

    Args:
        fit_path: .fit 文件路径。
        force: 遇到重复活动时改为更新已有活动的描述。

    Returns:
        dict: 执行成功返回 {status, strava_activity_id}。
    """
    from project_paths import resolve_project_path

    path = resolve_project_path(fit_path)
    from storage.repositories.activity import ActivityStore, file_content_key
    from operations.activity.strava import upload_activity_to_strava

    store = ActivityStore()
    indexed = store.get_activity_by_fit_path(str(path))
    activity_key = str(indexed.get("activity_key") or "") if indexed else ""
    if not activity_key and path.exists():
        activity_key = file_content_key(path)
    summary = store.get_report(activity_key) if activity_key else None
    if summary is None:
        return {"error": "no_summary", "message": f"Please analyze the activity first: {fit_path}"}
    strava_summary = summary.get("strava_summary")
    if not strava_summary:
        return {"error": "no_strava_summary", "message": "Summary does not contain strava_summary"}
    pending_activity = _pending_strava_activity_info(path, summary)

    try:
        result = upload_activity_to_strava(activity_key, wait=True, force=force)
    except requests.RequestException as exc:
        return {
            "error": "network_error",
            "message": f"Strava network request failed: {exc}",
            "pending_activity": pending_activity,
        }
    except TimeoutError as exc:
        return {
            "error": "network_error",
            "message": f"Strava upload timed out: {exc}",
            "pending_activity": pending_activity,
        }
    except (OSError, RuntimeError, ValueError) as exc:
        return {
            "error": "upload_failed",
            "message": str(exc),
            "pending_activity": pending_activity,
        }
    if result.get("status") == "duplicate":
        existing_activity = _existing_strava_activity_info(result.get("strava_activity_id"))
        return {
            "status": "duplicate",
            "strava_activity_id": result.get("strava_activity_id"),
            "existing_activity": existing_activity,
            "pending_activity": pending_activity,
            "message": result.get("message"),
        }
    if result.get("status") == "description_updated":
        existing_activity = _existing_strava_activity_info(result.get("strava_activity_id"))
        return {
            "status": "description_updated",
            "strava_activity_id": result.get("strava_activity_id"),
            "existing_activity": existing_activity,
            "pending_activity": pending_activity,
            "message": f"已更新 Strava 活动 {result.get('strava_activity_id')} 的描述。",
        }
    upload_status = result.get("upload_status") or {}
    activity_id = upload_status.get("activity_id")
    if not activity_id:
        return {"error": "upload_processing_failed", "status": result}
    return {
        "status": "uploaded",
        "strava_activity_id": activity_id,
        "pending_activity": pending_activity,
        "title": result.get("title"),
        "strava_summary_snippet": str(result.get("description", ""))[:120],
    }


def _pending_strava_activity_info(path: Path, summary: dict[str, Any]) -> dict[str, Any]:
    fit_summary = summary.get("fit_summary") if isinstance(summary.get("fit_summary"), dict) else {}
    return {
        "activity_key": summary.get("activity_key"),
        "fit_path": str(path),
        "sport_type": fit_summary.get("sport_type"),
        "start_time_local": fit_summary.get("start_time_local") or fit_summary.get("start_time"),
        "title": _default_upload_title(fit_summary, path),
        "strava_summary_snippet": str(summary.get("strava_summary") or "")[:120],
    }


def _existing_strava_activity_info(activity_id: Any) -> dict[str, Any]:
    activity_id_text = str(activity_id or "")
    return {
        "strava_activity_id": activity_id_text or None,
        "url": f"https://www.strava.com/activities/{activity_id_text}" if activity_id_text else None,
    }


def _default_upload_title(fit_summary: dict[str, Any], fit_path: Path) -> str:
    start = str(fit_summary.get("start_time_local") or fit_summary.get("start_time") or "")[:10]
    sport = fit_summary.get("sport_type") or "activity"
    return f"{start} {sport}" if start else fit_path.stem
