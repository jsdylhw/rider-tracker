"""Activity and saved-route Browser envelopes over the canonical repositories/API."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool


def create_catalog_browser_router(backend):
    router = APIRouter()

    def add(path, method, callback, *, model=None, status=200):
        async def handle(request: Request):
            try:
                backend._require_api_access(request)
                body = None
                if model:
                    raw = await request.json()
                    if not isinstance(raw, dict):
                        raise ValueError('Request must be a JSON object.')
                    body = model(**raw)
                result = await run_in_threadpool(callback, request, body)
                return JSONResponse({'ok': True, **result}, status_code=status)
            except HTTPException as exc:
                detail = exc.detail
                result = {'ok': False, 'error': detail.get('message', str(detail)) if isinstance(detail, dict) else str(detail)}
                if isinstance(detail, dict):
                    result.update({k: detail[k] for k in ('code', 'retryable') if k in detail})
                return JSONResponse(result, status_code=exc.status_code)
            except ValidationError as exc:
                return JSONResponse({'ok': False, 'error': str(exc)}, status_code=422)
            except ValueError as exc:
                return JSONResponse({'ok': False, 'error': str(exc)}, status_code=400)
            except Exception:
                return JSONResponse({'ok': False, 'error': 'Backend request failed.'}, status_code=500)
        router.add_api_route(path, handle, methods=[method])

    def activity(request, body):
        result = backend.get_activity_endpoint(request.path_params['activity_id'], request)
        if result['activity'].get('fitFilePath'):
            return {'activity': backend.activity_detail_endpoint(request.path_params['activity_id'], request, view='rider')}
        return result

    add('/api/activities', 'GET', lambda r, b: backend.list_activities_endpoint(r,
        limit=r.query_params.get('limit', '50'), offset=r.query_params.get('offset', '0'),
        sport_type=r.query_params.get('sportType', r.query_params.get('sport_type', '')), source=r.query_params.get('source', '')))
    add('/api/activities/{activity_id}', 'GET', activity)
    add('/api/activities/rider-session', 'POST', lambda r, b: backend.archive_rider_session_endpoint(b, r), model=backend.RiderSessionArchiveRequest)
    add('/api/activities/{activity_id}', 'PATCH', lambda r, b: backend.rename_activity_endpoint(r.path_params['activity_id'], b, r), model=backend.RenameActivityRequest)
    add('/api/activities/{activity_id}', 'DELETE', lambda r, b: backend.delete_activity_endpoint(r.path_params['activity_id'], r))
    add('/api/routes', 'GET', lambda r, b: backend.list_saved_routes_endpoint(r, source=r.query_params.get('source', '')))
    add('/api/routes', 'POST', lambda r, b: backend.save_route_endpoint(b, r), model=backend.SavedRouteRequest, status=201)
    add('/api/routes/{route_id}', 'GET', lambda r, b: backend.get_saved_route_endpoint(r.path_params['route_id'], r))
    add('/api/routes/{route_id}', 'PATCH', lambda r, b: backend.rename_saved_route_endpoint(r.path_params['route_id'], b, r), model=backend.RenameSavedRouteRequest)
    add('/api/routes/{route_id}', 'DELETE', lambda r, b: backend.delete_saved_route_endpoint(r.path_params['route_id'], r))
    add('/api/routes/{route_id}/progress', 'PUT', lambda r, b: backend.save_route_progress_endpoint(r.path_params['route_id'], b, r), model=backend.SavedRouteProgressRequest)
    add('/api/routes/{route_id}/progress', 'DELETE', lambda r, b: backend.clear_route_progress_endpoint(r.path_params['route_id'], r))
    return router
