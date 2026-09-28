"""Browser transport only: no retries, model execution or turn replay."""
import json
from urllib.parse import quote, urlsplit
import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from app.browser_body import MAX_BODY_BYTES

PATHS = (
    ('GET', '/api/agent/health'), ('GET', '/api/agent/sessions'), ('POST', '/api/agent/sessions'),
    ('GET', '/api/agent/sessions/{session_id}'), ('DELETE', '/api/agent/sessions/{session_id}'),
    ('POST', '/api/agent/chat'), ('POST', '/api/agent/route-plans/select'),
    ('POST', '/api/agent/route-plans/command'),
)


def create_agent_proxy_router(backend, base_url, token, *, transport=None):
    target = urlsplit(base_url)
    if (target.scheme != 'http' or target.hostname not in {'127.0.0.1', '::1', 'localhost'}
            or target.username or target.password or target.path not in ('', '/') or target.query or target.fragment or not token):
        raise ValueError('Agent transport requires a loopback HTTP endpoint and private token.')
    router = APIRouter()

    async def forward(request: Request):
        try:
            backend._require_api_access(request)
        except HTTPException as exc:
            return JSONResponse({'ok': False, 'error': str(exc.detail)}, status_code=exc.status_code)
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_BODY_BYTES:
                return JSONResponse({'ok': False, 'error': 'Request body too large.'}, status_code=413)
            body.extend(chunk)
        streaming = request.url.path == '/api/agent/chat' and 'application/x-ndjson' in request.headers.get('accept', '')
        schema = 'agent_stream.v1'
        if streaming:
            try:
                if json.loads(body).get('request_mode') == 'route_plan':
                    schema = 'route_stream.v1'
            except (ValueError, AttributeError):
                pass

        def stream_error():
            return json.dumps({'schema_version': schema, 'type': 'error',
                'message': 'Agent 连接中断；请检查会话结果后再决定是否重试。'}, ensure_ascii=False) + '\n'

        timeout = 600 if request.url.path.endswith(('/chat', '/command')) else 3
        client = httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                  timeout=httpx.Timeout(timeout, connect=1, pool=1))
        response = None
        handed_off = False
        try:
            headers = {'X-Rider-Agent-Token': token, 'Content-Type': request.headers.get('content-type', 'application/json'),
                       'Accept': request.headers.get('accept', 'application/json')}
            url = base_url.rstrip('/') + quote(request.url.path, safe='/')
            if request.url.query:
                url += '?' + request.url.query
            response = await client.send(client.build_request(request.method, url, content=bytes(body), headers=headers), stream=True)
            response_headers = {name: response.headers[name] for name in ('content-type', 'cache-control', 'x-accel-buffering') if name in response.headers}
            if streaming and response.status_code == 200 and 'application/x-ndjson' in response.headers.get('content-type', ''):
                async def events():
                    terminal = False
                    try:
                        async for line in response.aiter_lines():
                            if line.strip():
                                terminal = json.loads(line).get('type') in ('result', 'error')
                            yield line + '\n'
                            if terminal:
                                break
                        if not terminal:
                            yield stream_error()
                    except (httpx.HTTPError, ValueError, AttributeError):
                        if not terminal:
                            yield stream_error()
                    finally:
                        await response.aclose()
                        await client.aclose()
                handed_off = True
                return StreamingResponse(events(), media_type='application/x-ndjson', headers=response_headers)
            content = await response.aread()
            return Response(content, status_code=response.status_code, headers=response_headers)
        except httpx.HTTPError:
            if streaming:
                return Response(stream_error(), media_type='application/x-ndjson',
                                headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
            return JSONResponse({'ok': False, 'code': 'agent_unavailable', 'capability': 'backend',
                'retryable': True, 'error': 'Agent 进程暂不可用；基础 Rider 仍可使用。'}, status_code=503)
        finally:
            if not handed_off:
                if response is not None:
                    await response.aclose()
                await client.aclose()

    for method, path in PATHS:
        router.add_api_route(path, forward, methods=[method])
    return router
