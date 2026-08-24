from __future__ import annotations

import time

from operations.activity.report_batch import get_activity_report_job, submit_activity_report_rebuild
from storage.repositories.activity import ActivityStore, entry_from_fit_summary


def test_bulk_report_rebuild_runs_in_background_and_persists_v2(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    store = ActivityStore()
    activities = []
    for index in range(2):
        fit = tmp_path / f"ride-{index}.fit"
        fit.write_bytes(f"fit-{index}".encode())
        entry = entry_from_fit_summary(
            fit,
            {"sport_type": "cycling", "start_time_local": f"2026-08-1{index}T08:00:00"},
        )
        store.upsert_activity(entry)
        activities.append(entry)

    def fake_analyze(fit_path, **kwargs):
        activity = next(item for item in activities if item["fit_path"] == str(fit_path))
        report = {
            "schema_version": "llm_fit_file_analysis.v2",
            "status": "analyzed",
            "activity_key": activity["activity_key"],
            "fit_path": activity["fit_path"],
            "fit_summary": {"sport_type": "cycling"},
            "activity_metrics": {"schema_version": "activity_metrics.v2"},
            "analysis_summary": {"schema_version": "activity_analysis_summary.v1"},
            "markdown_report": "# report",
            "strava_summary": "summary",
        }
        store.save_report(report)
        return report

    monkeypatch.setattr("agent.analysis.agent.analyze_fit_file", fake_analyze)
    submitted = submit_activity_report_rebuild(scope="all")

    deadline = time.monotonic() + 5
    current = get_activity_report_job(submitted["job_id"])
    while current["status"] in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(0.01)
        current = get_activity_report_job(submitted["job_id"])

    assert current["status"] == "completed"
    assert current["completed"] == 2
    assert current["failed"] == 0
    assert store.report_counts() == {"llm_fit_file_analysis.v2": 2}


def test_bulk_report_rebuild_can_target_failed_activity_keys(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    store = ActivityStore()
    fits = []
    for index in range(2):
        fit = tmp_path / f"ride-{index}.fit"
        fit.write_bytes(f"fit-{index}".encode())
        entry = entry_from_fit_summary(fit, {"sport_type": "cycling"})
        store.upsert_activity(entry)
        fits.append(entry)

    called = []

    def fake_analyze(fit_path, **kwargs):
        called.append(str(fit_path))
        activity = next(item for item in fits if item["fit_path"] == str(fit_path))
        report = {
            "schema_version": "llm_fit_file_analysis.v2",
            "activity_key": activity["activity_key"],
            "fit_path": activity["fit_path"],
            "activity_metrics": {"schema_version": "activity_metrics.v2"},
            "analysis_summary": {"schema_version": "activity_analysis_summary.v1"},
        }
        store.save_report(report)
        return report

    monkeypatch.setattr("agent.analysis.agent.analyze_fit_file", fake_analyze)
    submitted = submit_activity_report_rebuild(
        scope="all",
        activity_keys=[fits[1]["activity_key"]],
    )
    deadline = time.monotonic() + 5
    current = get_activity_report_job(submitted["job_id"])
    while current["status"] in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(0.01)
        current = get_activity_report_job(submitted["job_id"])

    assert current["status"] == "completed"
    assert current["total"] == 1
    assert called == [fits[1]["fit_path"]]
