"""Loopback HTTP API of the voice engine (standard library only; JSON in and out).

    GET    /health                 state, device, engine + licence, defaults, measured speed
    POST   /v1/voices              {sampleWav: base64 WAV, language, consentId} → 201 {voiceId, referenceSec}
    GET    /v1/voices/{voiceId}    200 {voiceId, language} | 404
    DELETE /v1/voices/{voiceId}    200 {deleted} (idempotent)
    POST   /v1/speech              {voiceId, text, language, speed?, pitch?, exaggeration?,
                                    cfgWeight?, temperature?, seed?}
                                   → 200 {audioWav: base64 WAV PCM16 mono, sampleRate, durationMs,
                                          watermark, chunks, seconds,
                                          segments: [{text, startMs, endMs}]}
    POST   /v1/watermark           {audioWav: base64 WAV} → {watermark: 0..1, detected}

Errors: {"error": {"code", "message"}} with 4xx / 5xx. With VOICE_ENGINE_TOKEN set, every
request except /health needs `Authorization: Bearer <token>`.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import logging
import math
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol

from .engine import WATERMARK_THRESHOLD, EngineError
from .store import valid_voice_id

log = logging.getLogger("parlante_voice")

MAX_BODY_BYTES = 48 * 1024 * 1024
MAX_TEXT_CHARS = 5000


class Engine(Protocol):
    def health(self) -> dict: ...
    def register(self, sample_wav: bytes, language: str, consent_id: str) -> dict: ...
    def delete(self, voice_id: str) -> bool: ...
    def synthesize(self, voice_id: str, text: str, language: str, **options: Any) -> dict: ...
    def detect_watermark(self, wav: bytes) -> float: ...

    @property
    def store(self) -> Any: ...


class BadRequest(EngineError):
    def __init__(self, message: str) -> None:
        super().__init__("BAD_REQUEST", message, 400)


def _number(body: dict, key: str, low: float, high: float, default: float | None) -> float | None:
    value = body.get(key, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise BadRequest(f"{key} must be a number")
    if not low <= value <= high:
        raise BadRequest(f"{key} must be between {low} and {high}")
    return float(value)


def _string(body: dict, key: str, max_len: int) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise BadRequest(f"{key} must be a non-empty string of at most {max_len} characters")
    return value


def make_handler(engine: Engine, token: str = ""):
    class Handler(BaseHTTPRequestHandler):
        server_version = "parlante-voice/1"

        def log_message(self, fmt: str, *args: Any) -> None:  # requests are logged without content
            log.info("%s %s", self.command, self.path.split("?")[0])

        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _error(self, status: int, code: str, message: str) -> None:
            self._send(status, {"error": {"code": code, "message": message}})

        def _authorised(self) -> bool:
            if not token:
                return True
            given = self.headers.get("Authorization", "")
            return hmac.compare_digest(given.encode(), f"Bearer {token}".encode())

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                raise BadRequest("missing or too large JSON body")
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError as err:
                raise BadRequest("the body is not JSON") from err
            if not isinstance(body, dict):
                raise BadRequest("the body must be a JSON object")
            return body

        def _voice_id(self) -> str | None:
            parts = self.path.split("?")[0].strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["v1", "voices"]:
                return parts[2]
            return None

        def _dispatch(self) -> None:
            path = self.path.split("?")[0].rstrip("/") or "/"
            if self.command == "GET" and path == "/health":
                return self._send(200, engine.health())
            if not self._authorised():
                return self._error(401, "UNAUTHORIZED", "Missing or wrong token")
            if self.command == "POST" and path == "/v1/voices":
                body = self._body()
                try:
                    sample = base64.b64decode(_string(body, "sampleWav", MAX_BODY_BYTES), validate=True)
                except binascii.Error as err:
                    raise BadRequest("sampleWav must be base64") from err
                result = engine.register(sample, _string(body, "language", 8), _string(body, "consentId", 64))
                return self._send(201, result)
            if self.command == "POST" and path == "/v1/speech":
                body = self._body()
                voice_id = _string(body, "voiceId", 40)
                if not valid_voice_id(voice_id):
                    return self._error(404, "VOICE_NOT_FOUND", "Unknown voice")
                seed = body.get("seed", 7)
                if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**31:
                    raise BadRequest("seed must be a non-negative integer")
                result = engine.synthesize(
                    voice_id,
                    _string(body, "text", MAX_TEXT_CHARS),
                    _string(body, "language", 8),
                    speed=_number(body, "speed", 0.5, 2.0, 1.0),
                    pitch=_number(body, "pitch", -12.0, 12.0, 0.0),
                    exaggeration=_number(body, "exaggeration", 0.0, 2.0, None),
                    cfg_weight=_number(body, "cfgWeight", 0.0, 1.0, None),
                    temperature=_number(body, "temperature", 0.05, 2.0, None),
                    seed=seed,
                )
                wav = result.pop("wav")
                return self._send(200, {**result, "audioWav": base64.b64encode(wav).decode()})
            if self.command == "POST" and path == "/v1/watermark":
                body = self._body()
                try:
                    wav = base64.b64decode(_string(body, "audioWav", MAX_BODY_BYTES), validate=True)
                except binascii.Error as err:
                    raise BadRequest("audioWav must be base64") from err
                score = engine.detect_watermark(wav)
                return self._send(200, {"watermark": score, "detected": score >= WATERMARK_THRESHOLD})
            voice_id = self._voice_id()
            if voice_id is not None and self.command == "GET":
                meta = engine.store.meta(voice_id) if engine.store.exists(voice_id) else None
                if meta is None:
                    return self._error(404, "VOICE_NOT_FOUND", "Unknown voice")
                return self._send(200, {"voiceId": voice_id, "language": meta.get("language")})
            if voice_id is not None and self.command == "DELETE":
                return self._send(200, {"deleted": engine.delete(voice_id)})
            return self._error(404, "NOT_FOUND", "No such endpoint")

        def _handle(self) -> None:
            try:
                self._dispatch()
            except EngineError as err:
                self._error(err.status, err.code, str(err))
            except Exception:  # never leak internals; the log has the trace
                log.exception("request failed")
                self._error(int(HTTPStatus.INTERNAL_SERVER_ERROR), "INTERNAL", "The voice engine failed")

        do_GET = _handle
        do_POST = _handle
        do_DELETE = _handle

    return Handler


def serve(engine: Engine, host: str, port: int, token: str = "") -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(engine, token))
    server.daemon_threads = True
    return server
