"""Narration Browser contract; existing persistent jobs remain unchanged."""
import math
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool


def _number(value, minimum, maximum, field):
    try:
        number = float(value) if value not in (None, '') else 0
        if not math.isfinite(number) or not minimum <= number <= maximum:
            raise ValueError()
        return number
    except (ValueError, TypeError):
        raise ValueError(f'{field} 格式无效。') from None


def _optional(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def normalize_narration(body):
    fingerprint = str(body.get('route_fingerprint') or '').strip()
    name = str(body.get('route_name') or '').strip()[:200]
    if not re.fullmatch(r'route_[a-f0-9]{8}', fingerprint):
        raise ValueError('route_fingerprint 格式无效。')
    if not name:
        raise ValueError('route_name 不能为空。')
    total = _number(body.get('total_distance_m'), 1, 1_000_000, 'total_distance_m')
    duration = _number(body.get('estimated_duration_min'), 1, 10_000, 'estimated_duration_min')
    samples = body.get('samples')
    if not isinstance(samples, list) or not 2 <= len(samples) <= 64:
        raise ValueError('samples 必须包含 2-64 个路线采样点。')
    normalized = []
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise ValueError('samples 格式无效。')
        # Missing is not JavaScript null: Number(undefined) is invalid, whereas
        # Number(null) is zero. Never turn an absent location into (0, 0).
        for field in ('route_distance_m', 'latitude', 'longitude'):
            if field not in sample:
                raise ValueError(f'{field} 格式无效。')
        normalized.append({'sample_id': f'sample_{index + 1}',
            'route_distance_m': min(total, _number(sample.get('route_distance_m'), 0, total + 1, 'route_distance_m')),
            'latitude': _number(sample.get('latitude'), -90, 90, 'latitude'),
            'longitude': _number(sample.get('longitude'), -180, 180, 'longitude'),
            **{key: _optional(sample.get(key)) for key in ('estimated_elapsed_s', 'elevation_m', 'grade_percent')}})
    estimate = body.get('duration_estimation')
    if isinstance(estimate, dict):
        method = estimate.get('method')
        estimate = {'method': method if method in ('route_profile_at_60pct_ftp', 'route_duration', 'distance_at_24_kph') else 'distance_at_24_kph',
                    'target_power_w': _optional(estimate.get('target_power_w')), 'ftp_ratio': _optional(estimate.get('ftp_ratio'))}
    else:
        estimate = None
    request_id = str(body.get('request_id') or '').strip()
    if request_id and not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', request_id):
        raise ValueError('request_id 格式无效。')
    return {'route_fingerprint': fingerprint, 'route_name': name, 'total_distance_m': total,
            'estimated_duration_min': duration, 'duration_estimation': estimate, 'samples': normalized,
            'locale': 'en' if body.get('locale') == 'en' else 'zh-CN', 'force': body.get('force') is True,
            'request_id': request_id or None}


def create_narration_browser_router(backend):
    router = APIRouter()

    async def invoke(request, callback, *, prepare=False, status=200):
        try:
            backend._require_api_access(request)
            args = []
            if prepare:
                body = await request.json()
                if not isinstance(body, dict):
                    raise ValueError('请求必须是 JSON object。')
                args = [backend.RouteNarrationPrepareRequest(**normalize_narration(body))]
            result = await run_in_threadpool(callback, *args)
            return result if isinstance(result, Response) else JSONResponse({'ok': True, 'result': result}, status_code=status)
        except HTTPException as exc:
            message = exc.detail.get('message', str(exc.detail)) if isinstance(exc.detail, dict) else str(exc.detail)
            return JSONResponse({'ok': False, 'error': message}, status_code=exc.status_code)
        except ValidationError as exc:
            return JSONResponse({'ok': False, 'error': str(exc)}, status_code=422)
        except ValueError as exc:
            return JSONResponse({'ok': False, 'error': str(exc)}, status_code=400)
        except Exception:
            return JSONResponse({'ok': False, 'error': 'Backend request failed.'}, status_code=500)

    @router.post('/api/route-narrations/prepare')
    async def prepare(request: Request):
        return await invoke(request, lambda body: backend.prepare_route_narration_endpoint(body, request), prepare=True, status=202)

    @router.get('/api/route-narrations/jobs/{job_id}')
    async def job(job_id: str, request: Request):
        return await invoke(request, lambda: backend.get_route_narration_endpoint(job_id, request))

    @router.get('/api/route-narrations/photo')
    async def photo(request: Request):
        def read():
            name = request.query_params.get('name', '').strip()
            if not re.fullmatch(r'places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_-]+', name):
                raise ValueError('照片引用格式无效。')
            width = _optional(request.query_params.get('max_width')) or 720
            return backend.route_narration_photo_endpoint(request, name=name, max_width=int(min(1200, max(160, width))))
        return await invoke(request, read)
    return router
