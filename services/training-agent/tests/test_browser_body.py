import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from app.browser_body import BrowserBodyLimit


@pytest.mark.parametrize('chunked', [False, True])
def test_body_limit_precedes_execution_including_missing_length(chunked):
    app = FastAPI()
    calls = []
    @app.post('/api/test')
    async def endpoint(request: Request):
        calls.append(await request.body())
        return {'ok': True}
    app.add_middleware(BrowserBodyLimit, max_bytes=10)
    client = TestClient(app)
    body = iter([b'12345', b'678901']) if chunked else b'12345678901'
    assert client.post('/api/test', content=body).status_code == 413
    assert calls == []
    assert client.post('/api/test', content=b'1234567890').status_code == 200
    assert calls == [b'1234567890']


def test_multipart_exception_only_applies_to_fit_upload_routes():
    app = FastAPI()
    @app.post('/api/activities/fit-import')
    @app.post('/api/other')
    async def endpoint(request: Request):
        return {'size': len(await request.body())}
    app.add_middleware(BrowserBodyLimit, max_bytes=10)
    client = TestClient(app)
    assert client.post('/api/activities/fit-import', content=b'x' * 11, headers={'Content-Type': 'multipart/form-data'}).json() == {'size': 11}
    assert client.post('/api/activities/fit-import', content=b'x' * 11, headers={'Content-Type': 'application/json'}).status_code == 413
    assert client.post('/api/other', content=b'x' * 11, headers={'Content-Type': 'multipart/form-data'}).status_code == 413
