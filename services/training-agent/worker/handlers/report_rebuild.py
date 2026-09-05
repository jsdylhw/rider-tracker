"""Analyze without persistence; commit report + checkpoint behind the current lease."""
from project_paths import resolve_project_path
from services.capabilities import build_backend_capabilities
from settings import load_config
from storage.repositories.activity import file_content_key
from storage.repositories.job import LeaseLost
from storage.repositories.report_job import ReportCancelled, ReportInputChanged, ReportJobStore
from worker.runtime import JobCancelled, JobExecutionFailed


def rebuild_reports(context, payload, *, analyze=None, ai_available=None):
    repository = ReportJobStore(context.store)
    if ai_available is None:
        ai_available = build_backend_capabilities(load_config())["capabilities"]["activity_analysis"]
    if analyze is None and ai_available:
        from agent.analysis.agent import analyze_fit_file
        analyze = analyze_fit_file
    try:
        for item in repository.pending(context.claim["job_id"]):
            context.checkpoint()
            activity_id = item["activity_id"]
            if not ai_available:
                repository.fail(context.claim, activity_id, "ai_unavailable")
                continue
            try:
                fit = resolve_project_path(item["fit_path"])
                before = file_content_key(fit)
                if not repository.prepare(context.claim, activity_id, before):
                    continue
                result = analyze(fit, force=True, persist=False, use_history=False,
                                 activity_key=activity_id, database_path=context.store.path)
                context.checkpoint()
                if file_content_key(fit) != before:
                    raise ReportInputChanged("FIT changed while analysis was running.")
                repository.commit(context.claim, activity_id, result)
            except (LeaseLost, JobCancelled, ReportCancelled):
                raise
            except ReportInputChanged:
                repository.fail(context.claim, activity_id, "input_changed")
            except (FileNotFoundError, PermissionError):
                repository.fail(context.claim, activity_id, "fit_unavailable")
            except Exception:
                repository.fail(context.claim, activity_id, "analysis_failed")
    except ReportCancelled as exc:
        raise JobCancelled(str(exc)) from exc
    view = repository.view(context.claim["job_id"])
    result_ref = {"job_id": view["job_id"], "total": view["total"], "completed": view["completed"], "failed": view["failed"]}
    if view["failed"]:
        raise JobExecutionFailed(result_ref)
    return result_ref
