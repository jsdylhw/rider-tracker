"""Browser Agent URLs and envelopes; execution remains owned by the existing API."""
from __future__ import annotations

import json
import math
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool


def _text(value):
    return str(value or '').strip()


def _id(value, field):
    value = _text(value)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise ValueError(f'{field} 格式无效。')
    return value


def _name(value, field):
    value = _text(value)
    if not 1 <= len(value) <= 128:
        raise ValueError(f'{field} 格式无效。')
    return value


def _revision(value):
    try:
        number = float(value)
        if not math.isfinite(number) or not number.is_integer() or number < 1:
            raise ValueError()
        return int(number)
    except (TypeError, ValueError):
        raise ValueError('expected_revision 格式无效。') from None


def normalize_chat(body):
    result = {'session_id': _id(body.get('session_id'), 'session_id'), 'request_id': _id(body.get('request_id'), 'request_id')}
    message = _text(body.get('message'))
    if not 1 <= len(message) <= 20000:
        raise ValueError('message 必须是 1-20000 字符的文本。')
    mode, action = _text(body.get('request_mode') or 'chat'), _text(body.get('route_action'))
    if mode not in ('chat', 'route_plan'):
        raise ValueError('request_mode 格式无效。')
    if mode == 'route_plan' and action not in ('create', 'update', 'refine'):
        raise ValueError('route_plan 请求必须指定 create、update 或 refine。')
    if mode == 'chat' and action:
        raise ValueError('普通聊天不能指定 route_action。')
    result.update(message=message, request_mode=mode)
    if action:
        result['route_action'] = action
    reference = body.get('route_reference')
    if reference is not None:
        if mode != 'route_plan' or not isinstance(reference, dict):
            raise ValueError('route_reference 格式无效。')
        result['route_reference'] = {'plan_id': _name(reference.get('plan_id'), 'plan_id'), 'revision': _revision(reference.get('revision'))}
    options = body.get('route_options')
    if options is not None:
        if not isinstance(options, dict):
            raise ValueError('route_options 格式无效。')
        result['route_options'] = {}
        for field in ('include_elevation', 'include_ascent'):
            if field in options:
                if not isinstance(options[field], bool):
                    raise ValueError(f'route_options.{field} 必须是布尔值。')
                result['route_options'][field] = options[field]
    return result


def normalize_command(body):
    operation = _text(body.get('operation'))
    if operation not in ('get', 'generate_day', 'select', 'confirm', 'reverse', 'undo', 'explore_segments', 'compose_segments'):
        raise ValueError('不支持的路线操作。')
    result = {'session_id': _id(body.get('session_id'), 'session_id'), 'request_id': _id(body.get('request_id'), 'request_id'), 'operation': operation}
    for field in ('plan_id', 'candidate_id'):
        if body.get(field):
            result[field] = _name(body[field], field)
    if operation != 'get' or body.get('expected_revision') is not None:
        result['expected_revision'] = _revision(body.get('expected_revision'))
    if body.get('candidate_name'):
        result['candidate_name'] = _text(body['candidate_name'])[:200]
    if body.get('target_distance_km') is not None:
        try:
            distance = float(body['target_distance_km'])
            if not math.isfinite(distance) or distance <= 0:
                raise ValueError()
        except (TypeError, ValueError):
            raise ValueError('target_distance_km 格式无效。') from None
        result['target_distance_km'] = distance
    if operation == 'confirm':
        if not isinstance(body.get('saved_route'), dict):
            raise ValueError('saved_route 格式无效。')
        result['saved_route'] = body['saved_route']
    if operation == 'compose_segments':
        segments = body.get('segments')
        if not isinstance(segments, list) or not 1 <= len(segments) <= 3:
            raise ValueError('segments 必须包含 1-3 个路段。')
        result['segments'] = []
        for segment in segments:
            if not isinstance(segment, dict):
                raise ValueError('segment_id 格式无效。')
            try:
                segment_id = _revision(segment.get('segment_id'))
            except ValueError:
                raise ValueError('segment_id 格式无效。') from None
            direction = segment.get('direction')
            result['segments'].append({'segment_id': segment_id, 'direction': direction if direction in ('auto', 'forward', 'reverse') else 'auto'})
    if operation == 'explore_segments':
        for field, low, high, default in [('corridor_km', .1, 20, 5), ('max_segments', 1, 20, 12)]:
            try:
                number = float(body[field]) if body.get(field) is not None else (0 if field in body else default)
                number = min(high, max(low, number)) if math.isfinite(number) else default
            except (TypeError, ValueError):
                number = default
            result[field] = math.floor(number + .5) if field == 'max_segments' else number
    return result


def create_agent_browser_router(backend):
    router = APIRouter()

    async def invoke(request, callback, *, model=None, normalize=None, stream=False):
        args = []
        stream_ready = False

        def failure(message, status):
            if stream_ready and stream and 'application/x-ndjson' in request.headers.get('accept', ''):
                schema = 'route_stream.v1' if args and args[0].request_mode == 'route_plan' else 'agent_stream.v1'
                return Response(json.dumps({'schema_version': schema, 'type': 'error', 'message': message}) + '\n',
                                media_type='application/x-ndjson',
                                headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
            return JSONResponse({'ok': False, 'error': message}, status_code=status)

        try:
            backend._require_api_access(request)
            if model:
                body = await request.json()
                if not isinstance(body, dict):
                    raise ValueError('请求必须是 JSON object。')
                args.append(model(**(normalize(body) if normalize else body)))
            stream_ready = True
            result = await run_in_threadpool(callback, *args)
            return result if isinstance(result, Response) else {'ok': True, 'result': result}
        except HTTPException as exc:
            detail = exc.detail
            message = detail.get('message') or detail.get('error') or str(detail) if isinstance(detail, dict) else str(detail)
            return failure(message, exc.status_code)
        except backend.SessionUnavailable as exc:
            return failure(str(exc), 409)
        except ValidationError as exc:
            return failure(str(exc), 422)
        except ValueError as exc:
            return failure(str(exc), 400)
        except Exception:
            return failure('Backend request failed.', 500)

    @router.get('/api/agent/health')
    async def health(request: Request):
        return await invoke(request, backend.health)

    @router.get('/api/agent/sessions')
    async def sessions(request: Request):
        kind = request.query_params.get('kind') or 'chat'
        if kind not in ('chat', 'route_plan'):
            return JSONResponse({'ok': False, 'error': 'kind 格式无效。'}, status_code=422)
        return await invoke(request, lambda: backend.list_chat_sessions(request, kind))

    @router.post('/api/agent/sessions')
    async def create_session(request: Request):
        return await invoke(request, lambda body: backend.create_chat_session(body, request), model=backend.SessionCreateRequest)

    @router.get('/api/agent/sessions/{session_id}')
    async def session(session_id: str, request: Request):
        return await invoke(request, lambda: backend.get_chat_session(session_id, request))

    @router.delete('/api/agent/sessions/{session_id}')
    async def delete_session(session_id: str, request: Request):
        return await invoke(request, lambda: backend.delete_chat_session(session_id, request))

    @router.post('/api/agent/chat')
    async def chat(request: Request):
        return await invoke(request, lambda body: backend.chat_endpoint(body, request), model=backend.ChatRequest, normalize=normalize_chat, stream=True)

    @router.post('/api/agent/route-plans/select')
    async def select(request: Request):
        def normalize(body):
            return {'session_id': _id(body.get('session_id'), 'session_id'), 'request_id': _id(body.get('request_id'), 'request_id'),
                    'plan_id': _name(body.get('plan_id'), 'plan_id'), 'candidate_id': _name(body.get('candidate_id'), 'candidate_id'),
                    'expected_revision': _revision(body.get('expected_revision'))}
        return await invoke(request, lambda body: backend.select_route_candidate_endpoint(body, request), model=backend.SelectRouteCandidateRequest, normalize=normalize)

    @router.post('/api/agent/route-plans/command')
    async def command(request: Request):
        return await invoke(request, lambda body: backend.route_plan_command_endpoint(body, request), model=backend.RoutePlanCommandRequest, normalize=normalize_command)

    return router
