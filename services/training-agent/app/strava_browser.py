"""Browser Strava edge. Reuses existing backend operations without an HTTP self-proxy."""
from __future__ import annotations

import html
import json
import os
import secrets
import threading
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

DEFAULT_SCOPES = 'read,read_all,activity:read_all,activity:write'
COOKIE = 'rider_strava_oauth'
TTL_SECONDS = 600


def _text(value):
    return str(value or '').strip()


def _script(value):
    return json.dumps(value, ensure_ascii=True).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


def _page(title, message, *, ok=False, payload=None):
    payload = payload or {'type': 'rider-tracker:strava-error', 'message': message}
    return HTMLResponse(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title><style>body{{font-family:system-ui;background:#f3f5fb;padding:40px}}main{{max-width:640px;margin:auto;background:white;padding:28px;border-radius:14px}}p{{line-height:1.6}}</style>
<main><h1>{html.escape(title)}</h1><p>{html.escape(message)}</p><a href="/">返回 Rider Tracker</a></main>
<script>const payload={_script(payload)};if(window.opener){{window.opener.postMessage(payload,window.location.origin);setTimeout(()=>window.close(),800);}}</script></html>''', status_code=200 if ok else 400, headers={'Cache-Control': 'no-store'})


class OAuthStates:
    """Single-process, one-use states. Restart intentionally expires pending authorization."""
    def __init__(self, now=time.monotonic):
        self.now = now
        self.values = {}
        self.lock = threading.Lock()

    def create(self, user_id, browser_nonce):
        with self.lock:
            now = self.now()
            self.values = {key: value for key, value in self.values.items() if value[0] > now}
            if len(self.values) >= 1024:
                raise HTTPException(429, 'Too many pending authorizations.')
            state = secrets.token_urlsafe(32)
            self.values[state] = (now + TTL_SECONDS, user_id, browser_nonce)
            return state

    def consume(self, state, browser_nonce):
        with self.lock:
            value = self.values.get(state)
            if not value:
                return None
            if value[0] <= self.now():
                self.values.pop(state, None)
                return None
            if not browser_nonce or not secrets.compare_digest(value[2], browser_nonce):
                return None
            self.values.pop(state, None)
            return value[1]

    def discard(self, state):
        with self.lock:
            self.values.pop(state, None)


def create_strava_browser_router(backend, *, states=None):
    router = APIRouter()
    states = states or OAuthStates()

    def options(request):
        config = backend.load_config()
        rider = config.get('rider') or {}
        redirect = os.environ.get('STRAVA_REDIRECT_URI') or rider.get('strava_redirect_uri') or str(request.base_url).rstrip('/') + '/api/strava/auth/callback'
        scopes = ','.join(dict.fromkeys(DEFAULT_SCOPES.split(',') + _text(os.environ.get('STRAVA_SCOPES') or rider.get('strava_scopes')).split(','))).strip(',')
        frontend = os.environ.get('FRONTEND_REDIRECT_URL') or rider.get('frontend_redirect_url') or ''
        for url in (redirect, frontend):
            if url and (urlsplit(url).scheme not in ('http', 'https') or not urlsplit(url).netloc):
                raise HTTPException(400, 'OAuth redirect must be an absolute HTTP(S) URL.')
        return redirect, scopes, frontend

    def configured(request):
        result = backend.strava_config_endpoint(request)
        if not result['configured']:
            raise HTTPException(409, 'Missing Strava credentials. Configure the strava section in config.yaml.')
        return result

    def error_response(exc):
        status = exc.status_code if isinstance(exc, HTTPException) else 502
        message = exc.detail if isinstance(exc, HTTPException) else str(exc)
        result = {'ok': False, 'error': message}
        if status == 409 and 'Missing Strava credentials' in str(message):
            result.update(configured=False, loginUrl='/strava/login')
        return JSONResponse(result, status_code=status)

    @router.get('/api/strava/config')
    def config(request: Request):
        try:
            redirect, scopes, _ = options(request)
            return {'ok': True, **backend.strava_config_endpoint(request), 'loginUrl': '/strava/login', 'redirectUri': redirect, 'scopes': scopes}
        except Exception as exc:
            return error_response(exc)

    @router.post('/api/strava/config')
    def refuse_config(request: Request):
        backend._require_api_access(request)
        return JSONResponse({'ok': False, 'error': 'Strava credentials have one owner. Update config.yaml and restart Rider.'}, status_code=409)

    @router.get('/strava/login', response_class=HTMLResponse)
    def login(request: Request):
        # Credential configuration is never rendered. Starting authorization still requires API access.
        user = _text(request.query_params.get('userId')) or 'default'
        return HTMLResponse(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Strava Login - Rider Tracker</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui;background:#f3f5fb;color:#222f3e}}main{{box-sizing:border-box;width:min(680px,calc(100vw - 32px));padding:28px;background:white;border:1px solid #dfe4ea;border-radius:14px}}button{{padding:12px 16px;background:#fc4c02;color:white;border:0;border-radius:10px;cursor:pointer}}p{{color:#64748b;line-height:1.6}}</style>
<main><h1>连接 Strava</h1><p id="status">连接你的 Strava 账号。</p><button id="connect">继续授权 Strava</button></main>
<script>document.getElementById('connect').onclick=async()=>{{try{{const r=await fetch('/api/strava/auth/start?userId='+encodeURIComponent({_script(user)}));const b=await r.json();if(!r.ok)throw Error(b.error||b.detail||'授权失败');location.href=b.authUrl;}}catch(e){{document.getElementById('status').textContent=e.message;}}}};</script></html>''', headers={'Cache-Control': 'no-store'})

    @router.get('/api/strava/auth/start')
    def start(request: Request):
        state = None
        try:
            configured(request)
            redirect, scopes, _ = options(request)
            # Do not start a flow whose callback would land on a different state owner.
            if urlsplit(redirect).netloc != urlsplit(str(request.base_url)).netloc:
                raise HTTPException(409, 'OAuth callback must point to this Python entry. Check strava_redirect_uri.')
            user = _text(request.query_params.get('userId')) or 'default'
            nonce = secrets.token_urlsafe(32)
            state = states.create(user, nonce)
            result = backend.strava_auth_url_endpoint(backend.StravaAuthorizeRequest(redirect_uri=redirect, scope=scopes, state=state), request)
            response = JSONResponse({'ok': True, 'authUrl': result['auth_url'], 'state': state, 'userId': user}, headers={'Cache-Control': 'no-store'})
            response.set_cookie(COOKIE, nonce, max_age=TTL_SECONDS, httponly=True, samesite='lax', secure=request.url.scheme == 'https', path='/api/strava/auth')
            return response
        except Exception as exc:
            if state:
                states.discard(state)
            return error_response(exc)

    @router.get('/api/strava/auth/callback')
    def callback(request: Request):
        query = request.query_params
        user = states.consume(query.get('state', ''), request.cookies.get(COOKIE, ''))
        if user is None:
            return _page('Strava authorization expired', 'Missing code/state, or the authorization state has expired. Please try connecting again.')
        if query.get('error'):
            response = _page('Strava authorization failed', 'Strava returned: ' + query['error'])
        elif not query.get('code'):
            response = _page('Strava authorization expired', 'Missing authorization code.')
        elif not {'read', 'read_all'} <= {scope.strip() for scope in query.get('scope', '').split(',')}:
            response = _page('Strava route permission missing', 'Strava 未授予路线读取权限，请重新连接并允许全部请求权限。')
        else:
            try:
                # A verified one-use state + browser cookie authorizes this browser callback,
                # which cannot carry the server-to-server X-API-Token header.
                result = backend.StravaSink(require_access_token=False).exchange_authorization_code(query['code'])
                if not result.get('access_token'):
                    raise ValueError('Strava did not return an access token.')
                _, _, frontend = options(request)
                if frontend:
                    parsed = urlsplit(frontend)
                    params = dict(parse_qsl(parsed.query))
                    params.update(status='connected', userId=user, scope=query.get('scope', ''))
                    response = RedirectResponse(urlunsplit(parsed._replace(query=urlencode(params))), status_code=302)
                else:
                    response = _page('Strava connected', 'Authorization is complete. You can return to Rider Tracker and upload FIT files.', ok=True,
                                     payload={'type': 'rider-tracker:strava-connected', 'userId': user, 'scope': query.get('scope', '')})
            except Exception as exc:
                response = _page('Strava token exchange failed', str(exc))
        response.delete_cookie(COOKIE, path='/api/strava/auth')
        response.headers['Cache-Control'] = 'no-store'
        return response

    @router.get('/api/strava/connection')
    def connection(request: Request):
        try:
            result = backend.strava_connection_endpoint(request)
            return {**result, 'userId': _text(request.query_params.get('userId')) or 'default', 'expiresAt': result.get('expires_at')}
        except Exception as exc:
            return error_response(exc)

    @router.post('/api/strava/upload-fit')
    def retired_upload(request: Request):
        backend._require_api_access(request)
        return JSONResponse({'ok': False, 'error': 'Direct FIT upload is retired. Import the FIT into Rider before uploading it to Strava.'}, status_code=410)

    @router.post('/api/strava/upload-activity-fit')
    async def upload_activity(request: Request):
        from starlette.concurrency import run_in_threadpool
        try:
            configured(request)
            body = await request.json()
            if not isinstance(body, dict) or not _text(body.get('activityId')):
                raise HTTPException(400, 'Activity id is required.')
            def boolean(value):
                return _text(value).lower() in ('1', 'true', 'yes')
            description = '\n\n'.join(filter(None, [_text(body.get('fitDescription')), _text(body.get('message') or body.get('generatedMessage'))]))
            result = await run_in_threadpool(backend.strava_upload_activity_endpoint, backend.StravaStoredUploadRequest(
                activity_key=_text(body['activityId']), title=_text(body.get('activityName')) or None, description=description or None,
                trainer=boolean(body.get('trainer')), commute=boolean(body.get('commute')), sport_type=_text(body.get('sportType')) or None), request)
            return {'ok': True, 'userId': _text(body.get('userId')) or 'default', 'activityId': _text(body['activityId']), 'upload': result['upload']}
        except (json.JSONDecodeError, ValidationError):
            return error_response(HTTPException(400, 'Invalid upload parameters.'))
        except Exception as exc:
            return error_response(exc)

    @router.get('/api/strava/upload-status/{upload_id}')
    def upload_status(upload_id: str, request: Request):
        try:
            return {'ok': True, 'userId': _text(request.query_params.get('userId')) or 'default', 'status': backend.strava_upload_status_endpoint(upload_id, request)}
        except Exception as exc:
            return error_response(exc)

    def route_catalog(result, *, refreshed=False):
        return {'ok': True, 'routes': result.get('routes') or [], 'cachedAt': result.get('cachedAt'),
                'hasCache': True if refreshed else result.get('hasCache') is True}

    @router.get('/api/strava/routes')
    def routes(request: Request):
        try:
            return route_catalog(backend.strava_routes_endpoint(request))
        except Exception as exc:
            return error_response(exc)

    @router.post('/api/strava/routes/refresh')
    def refresh_routes(request: Request):
        try:
            configured(request)
            return route_catalog(backend.refresh_strava_routes_endpoint(request), refreshed=True)
        except Exception as exc:
            return error_response(exc)

    @router.get('/api/strava/routes/{route_id}/gpx')
    def route_gpx(route_id: str, request: Request):
        try:
            configured(request)
            try:
                number = int(route_id)
            except ValueError:
                raise HTTPException(400, 'route_id must be a positive integer') from None
            return backend.strava_route_gpx_endpoint(number, request)
        except Exception as exc:
            return error_response(exc)

    return router
