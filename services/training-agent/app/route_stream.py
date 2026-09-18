"""Request-scoped progress; final results still use the normal session transaction."""
import json
from queue import Queue, Empty
from threading import Event, Thread

from fastapi import HTTPException
from fastapi.responses import StreamingResponse


def route_stream_response(run):
    events = Queue()
    closed = Event()

    def emit(event):
        if not closed.is_set():
            events.put({"schema_version": "route_stream.v1", **event})

    def work():
        try:
            result = run(lambda progress: emit({"type": "progress", **progress}))
            emit({"type": "result", "result": result})
        except HTTPException as exc:
            emit({"type": "error", "message": str(exc.detail)})
        except Exception:
            emit({"type": "error", "message": "路线处理异常，请稍后重试。"})
        finally:
            events.put(None)

    def stream():
        Thread(target=work, daemon=True).start()
        try:
            while True:
                try:
                    event = events.get(timeout=10)
                except Empty:
                    yield '\n'
                    continue
                if event is None:
                    break
                yield json.dumps(event, ensure_ascii=False) + '\n'
        finally:
            # Disconnecting observers must not undo or replay an in-flight turn.
            closed.set()

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
