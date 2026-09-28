"""Private process hosting the existing Agent HTTP handlers unchanged."""
import hmac
import os
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from app import api
from app.agent_browser import create_agent_browser_router


def create_agent_process_app(token=None):
    token = token if token is not None else os.environ.get('RIDER_AGENT_PROCESS_TOKEN', '')
    if not token:
        raise RuntimeError('A private Agent process token is required.')
    app = FastAPI(title='Rider internal Agent process')

    @app.middleware('http')
    async def authenticate(request: Request, call_next):
        if not hmac.compare_digest(request.headers.get('X-Rider-Agent-Token', '').encode(), token.encode()):
            return JSONResponse({'ok': False, 'error': 'Internal authentication required.'}, status_code=401)
        request.state.agent_process_authenticated = True
        return await call_next(request)

    app.include_router(create_agent_browser_router(api))

    @app.get('/health')
    def health():
        return {'status': 'ok', 'service': 'rider-agent-process'}

    return app
