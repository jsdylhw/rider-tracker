"""Opt-in Rider static entry. Default app.api and Node startup stay unchanged."""
import os
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, FastAPI, Request
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles

from app import api
from app.strava_browser import create_strava_browser_router
from app.agent_browser import create_agent_browser_router
from app.catalog_browser import create_catalog_browser_router
from app.narration_browser import create_narration_browser_router
from app.browser_session import BrowserSessionMiddleware
from app.agent_proxy import create_agent_proxy_router
from app.browser_body import BrowserBodyLimit

# Source assets are deployment files, not mutable RIDER_PROJECT_ROOT/data paths.
ASSET_ROOT = Path(__file__).resolve().parents[3]
_BROWSER_DIRS = {'adapters', 'app', 'domain', 'shared', 'styles', 'ui'}


class BrowserFiles(StaticFiles):
    def __init__(self, directory, *, source=False, extensions=('.js',)):
        super().__init__(directory=directory, check_dir=False, follow_symlink=False)
        self.source = source
        self.extensions = extensions

    def get_path(self, scope):
        # Starlette normalizes URL paths to OS separators. On Windows those
        # backslashes are legitimate internal output, not user input. Reject
        # input backslashes first, then use portable separators for our policy.
        if '\\' in scope.get('path', ''):
            raise HTTPException(404)
        return super().get_path(scope).replace(os.sep, '/')

    async def get_response(self, path, scope):
        parts = PurePosixPath(path).parts
        if (any(ord(c) < 32 for c in path) or not parts or any(p.startswith('.') or '%' in p or '\\' in p or ':' in p for p in parts)
                or PurePosixPath(path).is_absolute()):
            raise HTTPException(404)
        if self.source and not (path == 'style.css' or parts[0] in _BROWSER_DIRS):
            raise HTTPException(404)
        if Path(path).suffix not in self.extensions:
            raise HTTPException(404)
        root = Path(self.directory).resolve()
        target = root.joinpath(*parts)
        cursor = root
        for part in parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise HTTPException(404)
        # Missing dependencies should be a 404 asset, not a startup failure.
        try:
            if not target.resolve().is_relative_to(root) or not target.is_file():
                raise HTTPException(404)
        except (OSError, ValueError, RuntimeError):
            raise HTTPException(404)
        response = await super().get_response(path, scope)
        response.headers['Cache-Control'] = 'no-cache'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        if response.status_code == 200:
            suffix = target.suffix
            response.headers['Content-Type'] = {'.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8'}[suffix]
        return response

    async def check_config(self):
        # Optional vendor dependency may not be installed yet.
        return


def create_browser_app(asset_root=None, *, agent_url=None, agent_token=None):
    app = FastAPI(title='Rider Browser Preview', middleware=list(api.app.user_middleware),
                  exception_handlers=dict(api.app.exception_handlers))
    agent_url = agent_url if agent_url is not None else os.environ.get('RIDER_AGENT_PROCESS_URL')
    agent_edge = create_agent_proxy_router(api, agent_url, agent_token or os.environ.get('RIDER_AGENT_PROCESS_TOKEN', '')) if agent_url else create_agent_browser_router(api)
    edges = [create_strava_browser_router(api), agent_edge, create_catalog_browser_router(api), create_narration_browser_router(api)]
    for edge in edges:
        app.include_router(edge)
    replaced = {(route.path, method) for edge in edges for route in edge.routes for method in route.methods}
    # Filter the source router before inclusion. New FastAPI versions retain
    # included routers as nested objects, so filtering app.routes afterwards
    # neither replaces '/' nor removes private execution aliases reliably.
    canonical = APIRouter()
    for route in api.app.router.routes:
        path = getattr(route, 'path', '')
        if path == '/' or any((path, method) in replaced for method in getattr(route, 'methods', [])):
            continue
        if agent_url and any(path == prefix or path.startswith(prefix + '/')
                             for prefix in ('/api/chat', '/api/chat-sessions', '/api/route-plans')):
            continue
        canonical.routes.append(route)
    app.include_router(canonical)
    root = Path(asset_root or os.environ.get('RIDER_BROWSER_ASSET_ROOT') or ASSET_ROOT)
    entry = BrowserFiles(root, extensions=('.html',))

    @app.api_route('/', methods=['GET', 'HEAD'], include_in_schema=False)
    async def rider_page(request: Request):
        return await entry.get_response('index.html', request.scope)

    app.add_middleware(BrowserBodyLimit)
    app.add_middleware(BrowserSessionMiddleware, load_config=lambda: api.load_config())
    app.mount('/src', BrowserFiles(root / 'src', source=True, extensions=('.js', '.css')), name='rider-source')
    vendor = root / 'vendor/@garmin/fitsdk'
    if not vendor.is_dir():
        vendor = root / 'node_modules/@garmin/fitsdk'
    app.mount('/vendor/@garmin/fitsdk', BrowserFiles(vendor), name='fit-sdk')
    return app


app = create_browser_app()
