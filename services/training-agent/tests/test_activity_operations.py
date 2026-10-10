from __future__ import annotations

import pytest

from agent.main_agent.context import AgentContext
from agent.tools.handlers.activity_operations import _install_synced_activity_selection
from operations.activity.reporting import ensure_summary
from operations.activity.catalog import resolve_recent
from operations.activity.sync import sync_recent
from operations.activity.upload import upload_activity


def test_index_failure_clears_stale_activity_focus(tmp_path):
    context = AgentContext(
        session_id="sync-index-failed",
        current_fit_file=tmp_path / "old.fit",
        selected_activities=[{"activity_key": "old", "fit_path": str(tmp_path / "old.fit")}],
    )

    _install_synced_activity_selection(
        {"status": "failed", "error": "activity_index_failed", "activities": []}, context,
    )

    assert context.selected_activities == []
    assert context.current_fit_file is None


def test_resolve_recent_is_explicit_and_does_not_need_agent_context(monkeypatch):
    monkeypatch.setattr(
        "operations.activity.catalog.list_activities",
        lambda **kwargs: {"count": 1, "activities": [{"activity_key": "a1", "fit_path": "a.fit"}]},
    )
    result = resolve_recent(limit=1)
    assert result["status"] == "completed"
    assert result["selection"] == {"kind": "recent", "limit": 1, "order": "latest", "sport_type": None}
    assert result["activities"][0]["activity_key"] == "a1"


def test_sync_recent_normalizes_partial_sync_result(monkeypatch):
    monkeypatch.setattr(
        "operations.activity.sync.sync_garmin_activities_tool",
        lambda count, force_download=False: {"downloaded": 1, "skipped": 0, "failed": 1, "indexed_items": [{"activity_key": "ok", "path": "ok.fit"}], "failed_items": [{"activity_id": 2, "error": "ConnectionError"}]},
    )
    result = sync_recent(count=2)
    assert result["status"] == "partial"
    assert result["activities"] == [{"activity_key": "ok", "path": "ok.fit"}]
    assert result["failed_items"][0]["activity_id"] == 2


def test_sync_recent_marks_fit_index_errors_partial(monkeypatch):
    monkeypatch.setattr(
        "operations.activity.sync.sync_garmin_activities_tool",
        lambda count, force_download=False: {
            "downloaded": 1,
            "skipped": 0,
            "failed": 0,
            "indexed_items": [],
            "index_errors": [{"path": "broken.fit", "error": "FitParseError"}],
        },
    )

    result = sync_recent(count=1)

    assert result["status"] == "partial"
    assert result["failed"] == 0
    assert result["index_failed"] == 1
    assert result["index_errors"][0]["error"] == "FitParseError"


def test_sync_recent_returns_sanitized_retryable_garmin_failure(monkeypatch):
    class GarminConnectAuthenticationError(Exception):
        pass

    failure = GarminConnectAuthenticationError("Failed to retrieve social profile")
    failure.__cause__ = OSError("SSL EOF from sensitive upstream URL")
    monkeypatch.setattr(
        "operations.activity.sync.sync_garmin_activities_tool",
        lambda count, force_download=False: (_ for _ in ()).throw(failure),
    )

    result = sync_recent(count=3)

    assert result["status"] == "failed"
    assert result["error"] == "garmin_profile_unavailable"
    assert result["retryable"] is True
    assert result["activities"] == []
    assert "sensitive upstream URL" not in result["message"]


def test_ensure_summary_requires_persisted_artifact(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    fit = tmp_path / "activity.fit"
    fit.write_bytes(b"fit")
    monkeypatch.setattr("operations.activity.reporting.analyze_fit_file_tool", lambda path, force: {"activity_key": "a1", "status": "analyzed"})
    missing = ensure_summary(fit)
    assert missing["status"] == "failed"
    assert missing["error"] == "report_not_persisted"
    from storage.repositories.activity import ActivityStore

    store = ActivityStore()
    store.upsert_activity({
        "activity_key": "a1",
        "fit_path": str(fit),
        "sport_type": "cycling",
        "source": "test",
    })
    store.save_report({
        "schema_version": "llm_fit_file_analysis.v2",
        "status": "analyzed",
        "activity_key": "a1",
        "fit_path": str(fit),
        "fit_summary": {"sport_type": "cycling"},
        "activity_metrics": {"schema_version": "activity_metrics.v2"},
        "analysis_summary": {"schema_version": "activity_analysis_summary.v1"},
    })
    completed = ensure_summary(fit)
    assert completed["status"] == "completed"
    assert completed["report_schema_version"] == "llm_fit_file_analysis.v2"


def test_upload_activity_normalizes_completed_and_failed_results(monkeypatch, tmp_path):
    fit = tmp_path / "activity.fit"
    fit.write_bytes(b"fit")
    monkeypatch.setattr("operations.activity.upload.upload_to_strava_tool", lambda path, force: {"status": "uploaded", "strava_activity_id": 123})
    uploaded = upload_activity(fit)
    assert uploaded["status"] == "completed"
    assert uploaded["outcome"] == "uploaded"
    monkeypatch.setattr("operations.activity.upload.upload_to_strava_tool", lambda path, force: {"error": "network_error", "message": "TLS EOF"})
    failed = upload_activity(fit)
    assert failed["status"] == "failed"
    assert failed["error"] == "network_error"


def test_embedded_operations_resolve_persisted_paths_from_rider_root(monkeypatch, tmp_path):
    nested_cwd = tmp_path / "services" / "training-agent"
    nested_cwd.mkdir(parents=True)
    fit = tmp_path / "data" / "files" / "fit" / "garmin" / "latest.fit"
    fit.parent.mkdir(parents=True)
    fit.write_bytes(b"fit")
    monkeypatch.setenv("RIDER_PROJECT_ROOT", str(tmp_path))
    monkeypatch.chdir(nested_cwd)

    analyzed_paths = []
    monkeypatch.setattr(
        "operations.activity.reporting.analyze_fit_file_tool",
        lambda path, force: analyzed_paths.append(path) or {
            "activity_key": "latest", "status": "analyzed", "error": "mock_failure",
        },
    )
    monkeypatch.setattr(
        "operations.activity.reporting.ActivityStore.get_report",
        lambda self, key: None,
    )
    analysis = ensure_summary("data/files/fit/garmin/latest.fit")

    uploaded_paths = []
    monkeypatch.setattr(
        "operations.activity.upload.upload_to_strava_tool",
        lambda path, force: uploaded_paths.append(path) or {
            "error": "network_error", "message": "mock offline",
        },
    )
    upload = upload_activity("data/files/fit/garmin/latest.fit")

    assert analysis["error"] == "mock_failure"
    assert analyzed_paths == [str(fit.resolve())]
    assert upload["error"] == "network_error"
    assert uploaded_paths == [str(fit.resolve())]


@pytest.mark.parametrize("retryable", [True, False])
def test_all_downloads_failed_exposes_error_and_retryability(monkeypatch, retryable):
    from agent.main_agent.tool_result import remember_failed_action, is_failed_tool_output
    failures = [{"activity_id": i, "error": "garmin_network_error", "retryable": retryable} for i in (1, 2)]
    monkeypatch.setattr("operations.activity.sync.sync_garmin_activities_tool", lambda **_: {
        "downloaded": 0, "skipped": 0, "failed": 2, "failed_items": failures,
    })
    result = sync_recent(count=2)
    assert result["status"] == "failed"
    assert result["error"] == "garmin_network_error"
    assert result["failed_items"] == failures
    assert result["retryable"] is retryable
    assert is_failed_tool_output(result)
    ctx = AgentContext(session_id="all-downloads-failed")
    remember_failed_action(ctx, "sync_garmin_activities", {"count": 2}, result)
    assert bool(ctx.last_failed_action) is retryable


@pytest.mark.parametrize("raw,expected", [
    ({"downloaded": 0, "skipped": 0, "failed": 0}, "completed"),
    ({"downloaded": 0, "skipped": 2, "failed": 0}, "completed"),
    ({"downloaded": 0, "skipped": 1, "failed": 1}, "partial"),
])
def test_empty_and_already_downloaded_are_not_all_failed(monkeypatch, raw, expected):
    monkeypatch.setattr("operations.activity.sync.sync_garmin_activities_tool", lambda **_: raw)
    result = sync_recent(count=2)
    assert result["status"] == expected
    assert "error" not in result


def test_all_downloads_failed_can_retry_through_control_turn(monkeypatch):
    from agent.main_agent.tool_result import remember_failed_action
    from agent.main_agent.turn_control import handle_control_turn
    from agent.tools.handlers.activity_operations import sync_garmin_activities
    calls = []
    def sync(**kwargs):
        calls.append(kwargs)
        return ({"failed": 2, "failed_items": [{"error": "garmin_network_error", "retryable": True}]}
                if len(calls) == 1 else {"failed": 0, "skipped": 2})
    monkeypatch.setattr("operations.activity.sync.sync_garmin_activities_tool", sync)
    ctx = AgentContext(session_id="download-retry", active_skill_id="sync-garmin-activities",
                       selected_activities=[{"activity_key": "old", "fit_path": "old.fit"}])
    result = sync_garmin_activities({"count": 2}, ctx)
    assert ctx.selected_activities == []
    remember_failed_action(ctx, "sync_garmin_activities", {"count": 2}, result)
    retried = handle_control_turn("重试", ctx)
    assert retried["status"] == "completed"
    assert len(calls) == 2 and calls[0] == calls[1]
    assert ctx.last_failed_action is None
