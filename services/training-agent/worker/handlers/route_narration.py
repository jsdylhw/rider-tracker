"""Generate a route narration plan with durable stage checkpoints."""
from __future__ import annotations

from services.capabilities import build_backend_capabilities
from settings import load_config
from storage.repositories.job import LeaseLost
from storage.repositories.narration_job import (
    NarrationCancelled,
    NarrationInputChanged,
    NarrationJobStore,
)
from worker.runtime import JobCancelled, JobExecutionFailed


def generate_route_narration(
    context,
    payload,
    *,
    research=None,
    compose=None,
    ai_available=None,
):
    repository = NarrationJobStore(context.store)
    try:
        existing = repository.ready_result(context.claim, payload)
        if existing is not None:
            return _result_ref(context.claim["job_id"], existing)

        if ai_available is None:
            ai_available = build_backend_capabilities(load_config())["capabilities"]["route_narration"]
        if not ai_available:
            repository.fail(context.claim, payload, "ai_unavailable")
            raise JobExecutionFailed({"job_id": context.claim["job_id"], "result_type": "route_narration"})

        if research is None or compose is None:
            from agent.narration.agent import compose_route_narration, research_route_narration
            research = research or research_route_narration
            compose = compose or compose_route_narration

        context.checkpoint({"stage": "researching_places", "completed": 0, "total": 3})
        evidence = research(payload)
        context.checkpoint({"stage": "composing_cards", "completed": 1, "total": 3})
        plan = compose(payload, evidence)
        context.checkpoint({"stage": "saving_plan", "completed": 2, "total": 3})
        repository.commit(context.claim, payload, plan)
        return _result_ref(context.claim["job_id"], plan)
    except (LeaseLost, JobCancelled, NarrationCancelled):
        raise
    except JobExecutionFailed:
        raise
    except NarrationInputChanged:
        repository.fail(context.claim, payload, "input_changed")
        raise JobExecutionFailed({"job_id": context.claim["job_id"], "result_type": "route_narration"})
    except Exception:
        repository.fail(context.claim, payload, "narration_failed")
        raise JobExecutionFailed({"job_id": context.claim["job_id"], "result_type": "route_narration"})


def _result_ref(job_id, plan):
    return {
        "job_id": job_id,
        "result_type": "route_narration",
        "route_fingerprint": plan["route_fingerprint"],
        "plan_id": plan["plan_id"],
    }
