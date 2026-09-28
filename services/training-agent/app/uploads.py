"""Multipart Browser API edge; business and file ownership remain in services."""
from __future__ import annotations

from contextlib import asynccontextmanager
import json
import logging

from fastapi import APIRouter, Request
from starlette.exceptions import HTTPException
from fastapi.responses import JSONResponse
from fitdecode.exceptions import FitError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from services.activity.upload import ActivityNotFound, upload_fit
from storage.repositories.activity import ActivityStoreBusy

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_BODY_BYTES = MAX_FILE_BYTES + 1024 * 1024
logger = logging.getLogger(__name__)


@asynccontextmanager
async def _form(request: Request):
    # Bound chunked requests too, before the multipart parser can spool arbitrary bytes.
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, 'FIT upload exceeds the 32 MiB file limit.')
        body.extend(chunk)

    async def receive():
        return {'type': 'http.request', 'body': bytes(body), 'more_body': False}

    bounded = Request(request.scope, receive)
    form = await bounded.form(max_files=1, max_fields=3)
    try:
        yield form
    finally:
        await form.close()


def create_upload_router(authorize) -> APIRouter:
    router = APIRouter()

    async def handle(request: Request, kind: str, activity_id: str | None = None):
        authorize(request)
        try:
            async with _form(request) as form:
                file = form.get('file')
                if not isinstance(file, UploadFile):
                    raise ValueError('Missing FIT file. Send multipart field named file.')
                if file.size is not None and file.size > MAX_FILE_BYTES:
                    raise HTTPException(413, 'FIT upload exceeds the 32 MiB file limit.')
                session = None
                if form.get('session'):
                    try:
                        session = json.loads(form['session'])
                    except (ValueError, TypeError):
                        raise ValueError('Invalid session JSON.') from None
                    if not isinstance(session, dict):
                        raise ValueError('Session metadata must be an object.')
                if kind == 'beacon' and session is None:
                    raise ValueError('Missing compact session metadata.')
                content = await file.read(MAX_FILE_BYTES + 1)
                if len(content) > MAX_FILE_BYTES:
                    raise HTTPException(413, 'FIT upload exceeds the 32 MiB file limit.')
                return await run_in_threadpool(
                    upload_fit, content, filename=file.filename or '', kind=kind, activity_id=activity_id,
                    session=session, name=str(form.get('name') or ''), sport_type=str(form.get('sportType') or 'Ride'),
                )
        except ActivityNotFound as exc:
            return JSONResponse({'ok': False, 'error': str(exc)}, status_code=404)
        except ActivityStoreBusy as exc:
            return JSONResponse({'ok': False, 'error': str(exc), 'code': 'activity_store_busy', 'retryable': True}, status_code=503)
        except (ValueError, FitError) as exc:
            return JSONResponse({'ok': False, 'error': str(exc)}, status_code=400)
        except HTTPException as exc:
            return JSONResponse({'ok': False, 'error': str(exc.detail)}, status_code=exc.status_code)
        except Exception:
            logger.exception('FIT upload failed')
            return JSONResponse({'ok': False, 'error': 'FIT upload failed.'}, status_code=500)

    @router.post('/api/activities/fit-import')
    async def import_fit(request: Request):
        return await handle(request, 'import')

    @router.post('/api/activities/fit-beacon')
    async def beacon_fit(request: Request):
        return await handle(request, 'beacon')

    @router.post('/api/activities/{activity_id}/fit')
    async def attach_fit(activity_id: str, request: Request):
        return await handle(request, 'attach', activity_id)

    return router
