"""Request-local routing HTTP budget, shared by retries and provider fallbacks."""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from time import monotonic

from integrations.provider_error import ProviderError


class RouteBudgetExceeded(ProviderError):
    def __init__(self):
        super().__init__(
            "本次算路请求预算或等待时间已用尽", stage="route_calculation",
            code="route_budget_exhausted", retryable=False,
        )


@dataclass
class RouteRequestBudget:
    max_requests: int
    deadline: float
    count: int = 0

    def consume(self, timeout_s: float) -> float:
        remaining = self.deadline - monotonic()
        if self.count >= self.max_requests or remaining <= 0:
            raise RouteBudgetExceeded()
        self.count += 1
        return min(timeout_s, remaining)


_active: ContextVar[RouteRequestBudget | None] = ContextVar("route_request_budget", default=None)


@contextmanager
def route_request_budget(*, max_requests: int = 36, timeout_s: float = 60.0):
    if max_requests < 1 or timeout_s <= 0:
        raise ValueError("route budget requires positive requests and timeout")
    budget = RouteRequestBudget(max_requests, monotonic() + timeout_s)
    token = _active.set(budget)
    try:
        yield budget
    finally:
        _active.reset(token)


def consume_route_request(timeout_s: float) -> float:
    budget = _active.get()
    return budget.consume(timeout_s) if budget is not None else timeout_s
