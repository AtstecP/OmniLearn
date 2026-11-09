"""Accept gzip-compressed request bodies.

Hosted platforms (Vercel) reject request bodies over ~4.5 MB with 413. Big imports are JSON text, which
compresses 5-10x, so the web client gzips large bodies and sends `Content-Encoding: gzip`. This middleware
unpacks them before FastAPI parses the JSON. The unpacked size is capped to guard against zip bombs.
"""
import json
import zlib

MAX_UNPACKED = 40 * 1024 * 1024


class GzipRequestMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        if headers.get(b"content-encoding", b"").strip().lower() != b"gzip":
            return await self.app(scope, receive, send)

        packed = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            packed += message.get("body", b"")
            if len(packed) > 20 * 1024 * 1024:
                return await self._fail(send, 413, "Request body too large")
            if not message.get("more_body"):
                break
        try:
            d = zlib.decompressobj(16 + zlib.MAX_WBITS)
            body = d.decompress(bytes(packed), MAX_UNPACKED)
            if d.unconsumed_tail:
                return await self._fail(send, 413, "Unpacked request body too large")
        except zlib.error:
            return await self._fail(send, 400, "Invalid gzip request body")

        scope = dict(scope)
        scope["headers"] = [(k, v) for k, v in scope["headers"] if k not in (b"content-encoding", b"content-length")] + [(b"content-length", str(len(body)).encode())]
        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    async def _fail(send, status, detail):
        payload = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())]})
        await send({"type": "http.response.body", "body": payload})
