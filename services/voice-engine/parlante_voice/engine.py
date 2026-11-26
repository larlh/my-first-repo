"""Chatterbox Multilingual with the Spain-Spanish T3, loaded once and shared by all requests.

Every output carries the Perth implicit watermark: Chatterbox applies it to each generated
chunk, and the finished audio is checked with the Perth detector before it is returned — audio
on which the mark is not detected is marked again, and refused if it still is not.

Environment fixes this code depends on (see README): `setuptools<81` (without
`pkg_resources` Perth's watermarker is None and Chatterbox does not start) and importing torch
and chatterbox BEFORE huggingface_hub / safetensors.
"""

from __future__ import annotations

import logging
import tempfile
import threading
import time
from dataclasses import dataclass

import numpy as np

from . import audio
from .config import LANGUAGES, Settings
from .manifest import ENGINE_ID, ENGINE_NAME, LICENCE, weight
from .store import VoiceStore, new_voice_id
from .text import split_text

log = logging.getLogger("parlante_voice")

MIN_REFERENCE_SEC = 3.0
WATERMARK_THRESHOLD = 0.5
SENTENCE_PAUSE_MS = 180


class EngineError(Exception):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass
class EngineState:
    ready: bool = False
    loading: bool = False
    error: str | None = None
    device: str | None = None
    load_seconds: float | None = None
    # Seconds of computation per second of audio, measured on the last syntheses.
    real_time_factor: float | None = None


class ChatterboxEngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = VoiceStore(settings.voices_dir)
        self.state = EngineState()
        self._lock = threading.Lock()  # one generation at a time on the device
        self._model = None
        self._torch = None
        self._conditionals_cls = None
        self._detector = None

    # ---------------------------------------------------------------- loading

    def start_loading(self) -> None:
        self.state.loading = True
        threading.Thread(target=self._load, name="voice-engine-load", daemon=True).start()

    def _load(self) -> None:
        started = time.monotonic()
        try:
            # Fix 3 of the recipe: torch and chatterbox first, hub / safetensors afterwards.
            import torch
            from chatterbox.models.s3gen import S3Gen
            from chatterbox.models.t3 import T3
            from chatterbox.models.t3.modules.t3_config import T3Config
            from chatterbox.models.tokenizers import MTLTokenizer
            from chatterbox.models.voice_encoder import VoiceEncoder
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS, Conditionals
            from huggingface_hub import hf_hub_download
            from safetensors.torch import load_file
            import perth

            if perth.PerthImplicitWatermarker is None:
                raise RuntimeError(
                    "the Perth watermarker is unavailable (install setuptools<81); "
                    "the engine never runs without its watermark"
                )

            wanted = self.settings.device
            if wanted == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("VOICE_ENGINE_DEVICE=cuda but CUDA is not available")
            device = wanted if wanted in ("cuda", "cpu") else ("cuda" if torch.cuda.is_available() else "cpu")

            def path_of(key: str) -> str:
                item = weight(key)
                return hf_hub_download(item.repo, item.filename, revision=item.revision, local_files_only=True)

            ve = VoiceEncoder()
            ve.load_state_dict(torch.load(path_of("ve"), map_location=device, weights_only=True))
            ve.to(device).eval()
            t3 = T3(T3Config.multilingual())
            state = load_file(path_of("t3_es_es"))
            state = state["model"][0] if "model" in state else state
            missing, unexpected = t3.load_state_dict(state, strict=False)
            if missing or unexpected:
                raise RuntimeError(f"T3 es-ES weights do not fit: {len(missing)} missing, {len(unexpected)} unexpected")
            t3.to(device).eval()
            s3 = S3Gen()
            s3.load_state_dict(torch.load(path_of("s3gen"), map_location=device, weights_only=True))
            s3.to(device).eval()
            path_of("cangjie")  # present in the cache, so the tokenizer never downloads it
            tokenizer = MTLTokenizer(path_of("tokenizer"))
            conds = Conditionals.load(path_of("conds"), map_location=device).to(device)
            model = ChatterboxMultilingualTTS(t3, s3, ve, tokenizer, device, conds=conds)
            if model.watermarker is None:
                raise RuntimeError("Chatterbox started without its watermarker")

            self._torch = torch
            self._conditionals_cls = Conditionals
            self._model = model
            self._detector = perth.PerthImplicitWatermarker()
            self.state.device = device
            self.state.ready = True
            self.state.load_seconds = round(time.monotonic() - started, 1)
            log.info("voice engine ready on %s in %.1f s", device, self.state.load_seconds)
        except Exception as err:  # reported by /health
            log.exception("voice engine failed to load")
            self.state.error = str(err) or err.__class__.__name__
        finally:
            self.state.loading = False

    def _require_ready(self) -> None:
        if self.state.ready:
            return
        if self.state.loading:
            raise EngineError("LOADING", "The voice engine is still loading its models", 503)
        raise EngineError("UNAVAILABLE", f"The voice engine could not start: {self.state.error}", 503)

    # ---------------------------------------------------------------- info

    def health(self) -> dict:
        return {
            "status": "ok",
            "ready": self.state.ready,
            "loading": self.state.loading,
            "error": self.state.error,
            "device": self.state.device,
            "engine": {"id": ENGINE_ID, "name": ENGINE_NAME, "licence": LICENCE},
            "languages": list(LANGUAGES),
            "watermark": "perth",
            "defaults": {
                "exaggeration": self.settings.exaggeration,
                "cfgWeight": self.settings.cfg_weight,
                "temperature": self.settings.temperature,
            },
            "voices": self.store.count(),
            "loadSeconds": self.state.load_seconds,
            "realTimeFactor": self.state.real_time_factor,
        }

    # ---------------------------------------------------------------- voices

    def register(self, sample_wav: bytes, language: str, consent_id: str) -> dict:
        self._require_ready()
        if language not in LANGUAGES:
            raise EngineError("UNSUPPORTED_LANGUAGE", f"This engine clones only: {', '.join(LANGUAGES)}", 422)
        try:
            samples, rate = audio.decode_wav(sample_wav)
        except ValueError as err:
            raise EngineError("BAD_SAMPLE", str(err), 422) from err
        samples = audio.trim(samples, rate)
        start, end = audio.speech_bounds(samples, rate)
        speech_sec = (end - start) / rate
        if speech_sec < MIN_REFERENCE_SEC:
            raise EngineError(
                "SAMPLE_TOO_SHORT",
                f"At least {MIN_REFERENCE_SEC:.0f} seconds of clear speech are needed",
                422,
            )
        voice_id = new_voice_id()
        directory = self.store.directory(voice_id)
        directory.mkdir(parents=True, exist_ok=True)
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", dir=self.settings.data_dir) as tmp:
                tmp.write(audio.encode_wav(samples, rate))
                tmp.flush()
                with self._lock:
                    model = self._model
                    model.prepare_conditionals(tmp.name, exaggeration=self.settings.exaggeration)
                    model.conds.save(self.store.conds_path(voice_id))
            self.store.write_meta(voice_id, {"language": language, "consentId": consent_id, "referenceSec": round(speech_sec, 2)})
        except Exception:
            self.store.delete(voice_id)
            raise
        return {"voiceId": voice_id, "referenceSec": round(min(speech_sec, 10.0), 2)}

    def delete(self, voice_id: str) -> bool:
        return self.store.delete(voice_id)

    # ---------------------------------------------------------------- speech

    def synthesize(
        self,
        voice_id: str,
        text: str,
        language: str,
        speed: float = 1.0,
        pitch: float = 0.0,
        exaggeration: float | None = None,
        cfg_weight: float | None = None,
        temperature: float | None = None,
        seed: int = 7,
    ) -> dict:
        self._require_ready()
        if language not in LANGUAGES:
            raise EngineError("UNSUPPORTED_LANGUAGE", f"This engine speaks only: {', '.join(LANGUAGES)}", 422)
        if not self.store.exists(voice_id):
            raise EngineError("VOICE_NOT_FOUND", "This voice does not exist in the voice engine", 404)
        torch = self._torch
        model = self._model
        rate = model.sr
        chunks = split_text(text)
        if not chunks:
            raise EngineError("EMPTY_TEXT", "There is no text to speak", 422)
        exaggeration = self.settings.exaggeration if exaggeration is None else exaggeration
        cfg_weight = self.settings.cfg_weight if cfg_weight is None else cfg_weight
        temperature = self.settings.temperature if temperature is None else temperature

        started = time.monotonic()
        parts: list[np.ndarray] = []
        # Where each chunk sits in the output (samples before any time stretch), so the caller
        # can place its words chunk by chunk instead of over the whole audio.
        spans: list[tuple[str, int, int]] = []
        offset = 0
        with self._lock:
            model.conds = self._conditionals_cls.load(self.store.conds_path(voice_id), map_location=self.state.device).to(self.state.device)
            for index, chunk in enumerate(chunks):
                torch.manual_seed(seed + index)
                wav = model.generate(
                    chunk,
                    language_id=language,
                    exaggeration=exaggeration,
                    cfg_weight=cfg_weight,
                    temperature=temperature,
                )
                part = audio.trim(wav.squeeze(0).cpu().numpy().astype(np.float32), rate)
                if parts:
                    pause = audio.silence(rate, SENTENCE_PAUSE_MS)
                    parts.append(pause)
                    offset += len(pause)
                parts.append(part)
                spans.append((chunk, offset, offset + len(part)))
                offset += len(part)
        samples = np.concatenate(parts)
        stretch = 1.0
        if abs(speed - 1.0) > 0.01 or abs(pitch) > 0.05:
            import librosa

            if abs(speed - 1.0) > 0.01:
                before = len(samples)
                samples = librosa.effects.time_stretch(samples, rate=speed)
                stretch = len(samples) / before
            if abs(pitch) > 0.05:
                samples = librosa.effects.pitch_shift(samples, sr=rate, n_steps=pitch)
        samples = np.clip(samples, -1.0, 1.0).astype(np.float32)
        samples, score = self._ensure_watermark(samples, rate)
        elapsed = time.monotonic() - started
        seconds = len(samples) / rate
        if seconds > 0:
            self.state.real_time_factor = round(elapsed / seconds, 2)
        segments = [
            {
                "text": chunk,
                "startMs": int(round(start * stretch * 1000 / rate)),
                "endMs": int(round(end * stretch * 1000 / rate)),
            }
            for chunk, start, end in spans
        ]
        return {**self._result(samples, rate, score, len(chunks), elapsed), "segments": segments}

    def detect_watermark(self, wav: bytes) -> float:
        """Perth detector score (0..1) of any 16-bit WAV: lets callers verify provenance."""
        self._require_ready()
        try:
            samples, rate = audio.decode_wav(wav)
        except ValueError as err:
            raise EngineError("BAD_AUDIO", str(err), 422) from err
        if len(samples) == 0:
            raise EngineError("BAD_AUDIO", "The audio is empty", 422)
        return round(float(self._detector.get_watermark(samples, sample_rate=rate)), 3)

    def _ensure_watermark(self, samples: np.ndarray, rate: int) -> tuple[np.ndarray, float]:
        score = float(self._detector.get_watermark(samples, sample_rate=rate))
        if score >= WATERMARK_THRESHOLD:
            return samples, score
        marked = np.asarray(self._model.watermarker.apply_watermark(samples, sample_rate=rate), dtype=np.float32)
        score = float(self._detector.get_watermark(marked, sample_rate=rate))
        if score < WATERMARK_THRESHOLD:
            raise EngineError("WATERMARK_FAILED", "The audio could not be watermarked; it is not returned", 500)
        return marked, score

    @staticmethod
    def _result(samples: np.ndarray, rate: int, watermark: float, chunks: int, elapsed: float) -> dict:
        return {
            "wav": audio.encode_wav(samples, rate),
            "sampleRate": rate,
            "durationMs": int(round(len(samples) * 1000 / rate)),
            "watermark": round(watermark, 3),
            "chunks": chunks,
            "seconds": round(elapsed, 2),
        }
