"""Process-wide AMap pacing and request-local retry progress (no credentials)."""
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock
from time import monotonic, sleep
from urllib.parse import urlsplit

from integrations.route_providers.budget import remaining_route_time

_lock = Lock()
_next = {}
_endpoint_locks = {}
_callback = ContextVar('map_retry_callback', default=None)


@contextmanager
def map_retry_progress(callback):
    token = _callback.set(callback)
    try:
        yield
    finally:
        _callback.reset(token)


def _emit(status, attempt):
    callback = _callback.get()
    if callback:
        try:
            callback({'stage': 'map_retry', 'status': status, 'attempt': attempt,
                      'label': '地图服务繁忙，正在等待重试' if status == 'running' else '正在重新请求地图服务'})
        except Exception:
            pass  # An observer must never replay or abort a provider operation.


def wait_seconds(seconds):
    remaining = remaining_route_time()
    if remaining is not None and seconds >= remaining:
        from integrations.route_providers.budget import RouteBudgetExceeded
        raise RouteBudgetExceeded()
    if seconds > 0:
        sleep(seconds)


def pace(url):
    # Account limits can span keys: conservatively share slots by endpoint,
    # never key by URL query strings containing credentials or coordinates.
    endpoint = urlsplit(url).path
    with _lock:
        endpoint_lock = _endpoint_locks.setdefault(endpoint, Lock())
    remaining = remaining_route_time()
    acquired = endpoint_lock.acquire(timeout=remaining) if remaining is not None else endpoint_lock.acquire()
    if not acquired:
        from integrations.route_providers.budget import RouteBudgetExceeded
        raise RouteBudgetExceeded()
    try:
        now = monotonic()
        wait_seconds(max(0.0, _next.get(endpoint, now) - now))
        _next[endpoint] = monotonic() + 1.05
    finally:
        endpoint_lock.release()


def retry_wait(attempt):
    _emit('running', attempt + 1)
    wait_seconds(min(8.0, 1.0 * 2 ** attempt))
    _emit('completed', attempt + 1)
