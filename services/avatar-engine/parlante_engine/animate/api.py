"""POST /v1/animations"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from parlante_engine.core import perf
from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import EngineError
from parlante_engine.core.jobs import get_job_manager
from parlante_engine.core.paths import resolve_input_file, resolve_output_dir
from parlante_engine.core.registry import get_registry
from parlante_engine.core.schemas import Request
from parlante_engine.core.video import wav_duration_seconds

from .controls import VISEMES, frame_count

router = APIRouter()
Viseme = Literal[VISEMES]  # type: ignore[valid-type]


class VisemeCue(BaseModel):
    tMs: float = Field(ge=0)
    viseme: Viseme


class WordCue(BaseModel):
    tMs: float = Field(ge=0)
    durMs: float = Field(ge=0)
    text: str = Field(default="", max_length=500)


class AnimateRequest(Request):
    portraitPath: str = Field(min_length=1, max_length=4096)
    maskPath: Optional[str] = Field(default=None, max_length=4096)
    audioPath: str = Field(min_length=1, max_length=4096)
    visemes: Optional[list[VisemeCue]] = Field(default=None, max_length=200_000)
    fps: int = Field(default=30, ge=1, le=60)
    maxSize: int = Field(default=512, ge=128, le=1024)
    outputDir: str = Field(min_length=1, max_length=4096)
    # ---- additive, optional (ignored by older engines) ----
    #: Word timeline of the narration: nods and brow raises follow word onsets.
    words: Optional[list[WordCue]] = Field(default=None, max_length=100_000)
    #: `auto` = viseme timeline when given, otherwise the audio-driven model.
    driver: Literal["auto", "visemes", "audio"] = "auto"
    #: Same request + seed => identical frames. Default: derived from the request itself.
    seed: Optional[int] = Field(default=None, ge=0, le=2**31 - 1)


@router.post("/v1/animations", status_code=202)
def animate(body: AnimateRequest) -> JSONResponse:
    from .service import AnimateJob, choose_driver, run_animation

    s = get_settings()
    reg = get_registry()
    portrait = resolve_input_file(body.portraitPath, "portraitPath", s.max_image_mb * 1024 * 1024)
    mask = resolve_input_file(body.maskPath, "maskPath", s.max_image_mb * 1024 * 1024) if body.maskPath else None
    audio = resolve_input_file(body.audioPath, "audioPath", s.max_audio_mb * 1024 * 1024)
    out = resolve_output_dir(body.outputDir)
    visemes = [c.model_dump() for c in body.visemes] if body.visemes else None
    job = AnimateJob(portrait, mask, audio, out, fps=body.fps, max_size=body.maxSize, visemes=visemes,
                     words=[w.model_dump() for w in body.words] if body.words else None, driver=body.driver,
                     seed=body.seed)
    driver = choose_driver(job)
    if not reg.capability_ready("animate"):
        raise EngineError("SERVICE_UNAVAILABLE", "Animation weights are missing. Run "
                          "`python scripts/download_models.py` in services/avatar-engine.", "weights_missing")
    if driver == "audio" and not reg.capability_ready("animate-audio"):
        raise EngineError("SERVICE_UNAVAILABLE", "This request has no viseme timeline and the audio-driven model "
                          "is not downloaded (run `python scripts/download_models.py --with-audio`).",
                          "weights_missing")
    duration = wav_duration_seconds(audio)
    if duration <= 0:
        raise EngineError("UNPROCESSABLE", "The audio file is empty.", "audio_empty")
    if duration > s.max_clip_seconds:
        raise EngineError("PAYLOAD_TOO_LARGE", f"Audio longer than {s.max_clip_seconds} s.", "audio_too_long")
    spf = perf.seconds_per_frame(driver) or perf.seconds_per_frame("visemes")
    eta = spf * frame_count(duration * 1000.0, body.fps) if spf else None
    manager = get_job_manager()
    handle = manager.submit("animate", lambda ctx: run_animation(job, ctx), eta_hint=eta, client_ref=body.clientRef)
    return JSONResponse(manager.describe(handle), status_code=202)
