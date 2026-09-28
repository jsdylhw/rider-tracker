"""Bound ordinary Browser API requests before JSON parsing, as the Node edge did."""
import re
from starlette.responses import JSONResponse

MAX_BODY_BYTES = 10 * 1024 * 1024
FIT_UPLOAD = re.compile(r'^/api/activities/(?:fit-import|fit-beacon|[^/]+/fit)$')


class BrowserBodyLimit:
    def __init__(self, app, *, max_bytes=MAX_BODY_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        # FIT multipart has its own 33 MiB body / 32 MiB file boundary and must
        # authorize before reading. No arbitrary multipart route bypasses this.
        path = scope.get('path', '')
        headers = dict(scope.get('headers', []))
        multipart = headers.get(b'content-type', b'').split(b';', 1)[0].strip().lower() == b'multipart/form-data'
        if (scope['type'] != 'http' or not path.startswith('/api/')
                or (scope.get('method') == 'POST' and multipart and FIT_UPLOAD.fullmatch(path))):
            return await self.app(scope, receive, send)
        try:
            declared = int(headers.get(b'content-length', b'0'))
        except ValueError:
            declared = 0
        too_large = JSONResponse({'ok': False, 'error': 'Request exceeds the 10 MiB limit.'}, status_code=413)
        if declared > self.max_bytes:
            return await too_large(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            chunk = message.get('body', b'')
            if len(body) + len(chunk) > self.max_bytes:
                return await too_large(scope, receive, send)
            body.extend(chunk)
            if not message.get('more_body', False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
            return await receive()

        await self.app(scope, replay, send)
