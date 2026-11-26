"""Fast tests without the model: text chunking, WAV helpers, voice store and the HTTP layer.

    .venv/bin/python -m unittest discover -s tests          (from services/voice-engine)
"""

from __future__ import annotations

import base64
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

from parlante_voice import audio
from parlante_voice.engine import EngineError
from parlante_voice.server import serve
from parlante_voice.store import VoiceStore, new_voice_id, valid_voice_id
from parlante_voice.text import MAX_CHARS, split_text


class TextTest(unittest.TestCase):
    def test_short_sentences_are_merged_and_long_ones_split(self) -> None:
        self.assertEqual(split_text("  Hola.   ¿Qué tal?  "), ["Hola. ¿Qué tal?"])
        long = "palabra " * 80
        chunks = split_text(f"Uno, {long}. Fin.")
        self.assertTrue(all(len(chunk) <= MAX_CHARS for chunk in chunks))
        self.assertEqual(" ".join(chunks).split(), f"Uno, {long}. Fin.".split())
        self.assertEqual(split_text("   "), [])


class AudioTest(unittest.TestCase):
    def test_round_trip_and_trim(self) -> None:
        rate = 24000
        tone = 0.5 * np.sin(np.linspace(0, 2 * np.pi * 220, rate)).astype(np.float32)
        padded = np.concatenate([audio.silence(rate, 500), tone, audio.silence(rate, 500)])
        decoded, decoded_rate = audio.decode_wav(audio.encode_wav(padded, rate))
        self.assertEqual(decoded_rate, rate)
        self.assertEqual(len(decoded), len(padded))
        trimmed = audio.trim(decoded, rate, pad_ms=0)
        self.assertLess(abs(len(trimmed) - rate), rate * 0.05)
        with self.assertRaises(ValueError):
            audio.decode_wav(b"not a wav")


class StoreTest(unittest.TestCase):
    def test_ids_are_validated_and_delete_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = VoiceStore(Path(tmp))
            voice_id = new_voice_id()
            self.assertTrue(valid_voice_id(voice_id))
            self.assertFalse(valid_voice_id("../etc"))
            store.write_meta(voice_id, {"language": "es"})
            store.conds_path(voice_id).write_bytes(b"x")
            self.assertTrue(store.exists(voice_id))
            self.assertEqual(store.count(), 1)
            self.assertTrue(store.delete(voice_id))
            self.assertFalse(store.delete(voice_id))
            self.assertFalse(store.delete("../../x"))
            self.assertFalse((Path(tmp) / voice_id).exists())


class FakeEngine:
    def __init__(self, root: Path) -> None:
        self.store = VoiceStore(root)
        self.calls: list[tuple] = []

    def health(self) -> dict:
        return {"status": "ok", "ready": True}

    def register(self, sample_wav: bytes, language: str, consent_id: str) -> dict:
        audio.decode_wav(sample_wav)
        voice_id = new_voice_id()
        self.store.write_meta(voice_id, {"language": language, "consentId": consent_id})
        self.store.conds_path(voice_id).write_bytes(b"x")
        return {"voiceId": voice_id, "referenceSec": 1.0}

    def delete(self, voice_id: str) -> bool:
        return self.store.delete(voice_id)

    def synthesize(self, voice_id: str, text: str, language: str, **options) -> dict:
        if not self.store.exists(voice_id):
            raise EngineError("VOICE_NOT_FOUND", "Unknown voice", 404)
        self.calls.append((voice_id, text, language, options))
        return {"wav": audio.encode_wav(audio.silence(24000, 100), 24000), "sampleRate": 24000,
                "durationMs": 100, "watermark": 1.0, "chunks": 1, "seconds": 0.1}

    def detect_watermark(self, wav: bytes) -> float:
        audio.decode_wav(wav)
        return 0.2


class HttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = FakeEngine(Path(self.tmp.name))
        self.server = serve(self.engine, "127.0.0.1", 0, token="secret")
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def call(self, method: str, path: str, body: dict | None = None, token: str = "secret") -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def test_voice_lifecycle(self) -> None:
        self.assertEqual(self.call("GET", "/health", token="")[0], 200)
        self.assertEqual(self.call("POST", "/v1/voices", {}, token="wrong")[0], 401)
        sample = base64.b64encode(audio.encode_wav(audio.silence(16000, 100), 16000)).decode()
        status, created = self.call("POST", "/v1/voices", {"sampleWav": sample, "language": "es", "consentId": "cns_1"})
        self.assertEqual(status, 201)
        voice_id = created["voiceId"]
        self.assertEqual(self.call("GET", f"/v1/voices/{voice_id}")[1]["language"], "es")
        status, speech = self.call("POST", "/v1/speech", {"voiceId": voice_id, "text": "Hola", "language": "es", "speed": 1.1})
        self.assertEqual(status, 200)
        self.assertEqual(audio.decode_wav(base64.b64decode(speech["audioWav"]))[1], 24000)
        self.assertEqual(self.engine.calls[0][3]["speed"], 1.1)
        bad = self.call("POST", "/v1/speech", {"voiceId": voice_id, "text": "Hola", "language": "es", "speed": 9})
        self.assertEqual(bad[0], 400)
        detected = self.call("POST", "/v1/watermark", {"audioWav": speech["audioWav"]})
        self.assertEqual(detected, (200, {"watermark": 0.2, "detected": False}))
        self.assertEqual(self.call("DELETE", f"/v1/voices/{voice_id}")[1], {"deleted": True})
        self.assertEqual(self.call("DELETE", f"/v1/voices/{voice_id}")[1], {"deleted": False})
        missing = self.call("POST", "/v1/speech", {"voiceId": voice_id, "text": "Hola", "language": "es"})
        self.assertEqual(missing[0], 404)
        self.assertEqual(missing[1]["error"]["code"], "VOICE_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
