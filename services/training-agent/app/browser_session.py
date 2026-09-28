"""Local browser authentication for the unified entry, separate from API tokens.

Node previously held the service token on the browser's behalf. The Python entry
uses an HttpOnly local session instead; the token never appears in HTML or JS.
The internal app.api entry does not install this middleware.
"""
import secrets
import threading
import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from app.browser_security import reject_untrusted_browser_request

COOKIE = 'rider_browser_session'
TTL_SECONDS = 12 * 60 * 60
LOOPBACK = {'127.0.0.1', '::1', 'localhost', 'testclient'}


class BrowserSessionMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, load_config, now=time.monotonic):
        super().__init__(app)
        self.load_config = load_config
        self.now = now
        self.sessions = {}
        self.lock = threading.Lock()

    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith('/api/') and request.url.path not in ('/', '/strava/login'):
            return await call_next(request)
        config = self.load_config()
        # Apply the same Host/Origin rules to session creation pages as to API calls.
        check_scope = {**request.scope, 'path': '/api/browser-session-check', 'raw_path': b'/api/browser-session-check'}
        trusted_local = request.client and request.client.host in LOOPBACK and reject_untrusted_browser_request(Request(check_scope), config) is None
        token = request.cookies.get(COOKIE, '')
        now = self.now()
        with self.lock:
            expires = self.sessions.get(token, 0)
        # State is created only by this entry; ordinary headers cannot assert it.
        request.state.local_browser_authenticated = bool(trusted_local and expires > now)
        response = await call_next(request)
        if (trusted_local and request.method == 'GET' and request.url.path in ('/', '/strava/login')
                and response.status_code in (200, 304) and config.get('web_api_token')):
            with self.lock:
                self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
                # Another page request may have evicted this cookie while the
                # response was being produced; recheck under the mutation lock.
                expires = self.sessions.get(token, 0)
                if expires <= now:
                    if len(self.sessions) >= 256:
                        self.sessions.pop(min(self.sessions, key=self.sessions.get))
                    token = secrets.token_urlsafe(32)
                    self.sessions[token] = now + TTL_SECONDS
                expires = self.sessions[token]
            response.set_cookie(COOKIE, token, httponly=True, samesite='strict', secure=request.url.scheme == 'https',
                                max_age=max(1, int(expires - now)), path='/')
        return response
