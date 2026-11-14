"""Animation job: prepared portrait + audio (+ viseme timeline) -> clip + matte clip."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from parlante_engine.core import perf
from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import EngineError, JobCanceled
from parlante_engine.core.jobs import JobContext
from parlante_engine.core.registry import get_registry
from parlante_engine.core.video import VideoWriter, decode_audio, wav_duration_seconds

from . import controls as C
from .lp import Avatar, Paster, avatar_cache_path, file_sha256, get_engine
from .matte import MatteTracker, load_matte

log = logging.getLogger("parlante.animate")
MODEL_NAME = {
    "visemes": "liveportrait-onnx+viseme-rig",
    "audio": "liveportrait-onnx+ditto-audio2motion",
}


@dataclass
class AnimateJob:
    portrait_path: Path
    mask_path: Path | None
    audio_path: Path
    output_dir: Path
    fps: int = 30
    max_size: int = 512
    visemes: list[dict] | None = None
    words: list[dict] | None = None
    driver: str = "auto"            # auto | visemes | audio
    seed: int | None = None
    max_frames: int | None = None   # benchmark / tests only


def read_portrait(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise EngineError("UNPROCESSABLE", "portraitPath could not be read as an image.", "portrait_unreadable")
    if img.dtype == np.uint16:
        img = (img / 257).astype(np.uint8)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        img = img[..., :3]
    h, w = img.shape[:2]
    if max(h, w) > 2048 or min(h, w) < 128:
        raise EngineError("UNPROCESSABLE", "The portrait must be between 128 and 2048 pixels per side; "
                          "prepare it first with /v1/portraits/prepare.", "portrait_size")
    return np.ascontiguousarray(img)


def load_avatar(portrait_path: Path, bgr: np.ndarray, on_step=None) -> Avatar:
    """Cached appearance + keypoints of a portrait (keyed by the file's sha256); computed and
    cached on a miss, so any portrait with a detectable face can be animated."""
    from parlante_engine.prepare.face import get_face_landmarker

    sha = file_sha256(portrait_path)
    cache = avatar_cache_path(sha)
    avatar = Avatar.load(cache, sha) if cache.is_file() else None
    if avatar is not None and (avatar.width, avatar.height) == (bgr.shape[1], bgr.shape[0]):
        return avatar
    lm = get_face_landmarker().landmarks(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    if lm is None:
        raise EngineError("UNPROCESSABLE", "No face was found in the portrait.", "no_face")
    avatar = get_engine().register(bgr, lm, sha, on_step)
    avatar.save(cache)
    return avatar


def default_seed(job: AnimateJob, portrait_sha: str) -> int:
    """Stable seed when the request gives none: the same request always yields the same clip."""
    h = hashlib.sha256()
    h.update(portrait_sha.encode())
    h.update(json.dumps(job.visemes or [], sort_keys=True).encode())
    h.update(str(job.fps).encode())
    return int.from_bytes(h.digest()[:4], "big") % 1_000_000


def output_size(width: int, height: int, max_size: int) -> tuple[int, int]:
    s = min(1.0, max_size / float(max(width, height)))
    w, h = int(round(width * s)), int(round(height * s))
    return max(2, w - w % 2), max(2, h - h % 2)


def choose_driver(job: AnimateJob) -> str:
    if job.driver in ("visemes", "audio"):
        if job.driver == "visemes" and not job.visemes:
            raise EngineError("VALIDATION_ERROR", "driver 'visemes' needs a viseme timeline.", "visemes_required")
        return job.driver
    return "visemes" if job.visemes else "audio"


def run_animation(job: AnimateJob, ctx: JobContext | None = None) -> dict:
    """Runs inside the job worker. Returns the `animate` result of the HTTP contract plus a
    `stats` object with the measurements of this very run."""
    t_start = time.monotonic()
    reg = get_registry()
    peak = [perf.rss_mb()]

    def sample_rss() -> None:
        peak[0] = max(peak[0], perf.rss_mb())

    driver_name = choose_driver(job)
    if not reg.capability_ready("animate"):
        raise EngineError("SERVICE_UNAVAILABLE", "Animation weights are missing. Run scripts/download_models.py.",
                          "weights_missing")
    if driver_name == "audio" and not reg.capability_ready("animate-audio"):
        raise EngineError("SERVICE_UNAVAILABLE", "The audio-driven model is not downloaded "
                          "(run scripts/download_models.py --with-audio) and the request has no viseme timeline.",
                          "weights_missing")
    job.output_dir.mkdir(parents=True, exist_ok=True)
    duration = wav_duration_seconds(job.audio_path)
    if duration <= 0.0:
        raise EngineError("UNPROCESSABLE", "The audio file is empty.", "audio_empty")
    if duration > get_settings().max_clip_seconds:
        raise EngineError("PAYLOAD_TOO_LARGE", f"Audio longer than {get_settings().max_clip_seconds} s.",
                          "audio_too_long")
    fps = int(job.fps)
    n_total = C.frame_count(duration * 1000.0, fps)
    n = n_total if not job.max_frames else min(n_total, job.max_frames)
    spf_hint = perf.seconds_per_frame(driver_name) or perf.seconds_per_frame("visemes")
    if ctx:
        ctx.progress(0.0, spf_hint * n if spf_hint else None)

    engine = get_engine()
    bgr = read_portrait(job.portrait_path)
    avatar = load_avatar(job.portrait_path, bgr)
    seed = job.seed if job.seed is not None else default_seed(job, avatar.portrait_sha256)
    if ctx:
        ctx.check_canceled()

    from .drivers import AudioDriver, VisemeDriver
    setup_span = 0.02 if driver_name == "visemes" else 0.12
    if driver_name == "visemes":
        driver = VisemeDriver(engine, avatar, job.visemes or [], duration * 1000.0, fps, seed, job.words, n_total)
    else:
        def on_stage(stage: str, frac: float) -> None:
            sample_rss()
            if ctx:
                base = 0.0 if stage == "features" else setup_span * 0.3
                span = setup_span * (0.3 if stage == "features" else 0.7)
                ctx.progress(base + span * frac, (spf_hint * n) if spf_hint else None)

        wav = decode_audio(job.audio_path, 16000)
        driver = AudioDriver(engine, avatar, wav, fps, seed, n_total, job.visemes, on_stage=on_stage,
                             check_canceled=ctx.check_canceled if ctx else None)

    out_w, out_h = output_size(avatar.width, avatar.height, job.max_size)
    paster = Paster(avatar, bgr, out_w, out_h)
    tracker = None
    if job.mask_path is not None:
        tracker = MatteTracker(avatar, paster, bgr, load_matte(job.mask_path, avatar.width, avatar.height))
    video_path = job.output_dir / "avatar.mp4"
    matte_path = job.output_dir / "avatar-matte.mp4"
    writer = VideoWriter(video_path, out_w, out_h, fps)
    matte_writer = VideoWriter(matte_path, out_w, out_h, fps, gray=True, crf=18) if tracker else None
    t_setup = time.monotonic() - t_start
    sample_rss()
    if ctx:
        ctx.set_total(n, spf_hint, base=setup_span, span=1.0 - setup_span)
    digest = hashlib.sha256()
    t_loop = time.monotonic()
    load0 = os.getloadavg()[0]
    try:
        for f in range(n):
            if ctx:
                ctx.check_canceled()
            x_d = engine.stitch(avatar.x_s, driver.keypoints(f))
            crop = engine.render(avatar, x_d)
            frame = paster.paste(crop)
            digest.update(frame.tobytes())
            writer.write(frame)
            if matte_writer:
                matte_writer.write(tracker.frame_matte(crop))
            if f % 8 == 0:
                sample_rss()
            if ctx:
                ctx.advance(f + 1)
        writer.close()
        if matte_writer:
            matte_writer.close()
    except (JobCanceled, Exception):
        writer.abort()
        if matte_writer:
            matte_writer.abort()
        raise
    loop_s = time.monotonic() - t_loop
    spf = loop_s / n
    if n >= 5:
        perf.record(driver_name, spf, n, {"setupSeconds": round(t_setup, 2), "fps": fps, "source": "job",
                                          "backend": engine.generator.backend}, peak_rss=peak[0])
    stats = {
        "driver": driver_name, "seed": seed, "frames": n, "secondsPerFrame": round(spf, 4),
        "renderSeconds": round(loop_s, 2), "setupSeconds": round(t_setup, 2),
        "totalSeconds": round(time.monotonic() - t_start, 2), "loadAvgStart": round(load0, 2),
        "loadAvgEnd": round(os.getloadavg()[0], 2), "peakRssMb": round(peak[0], 0),
        "processPeakRssMb": round(perf.peak_rss_mb(), 0),
        "backend": engine.generator.backend, "framesSha256": digest.hexdigest(),
    }
    log.info("animation done: %s", stats)
    return {
        "kind": "animate",
        "videoPath": str(video_path),
        "alpha": "mask-video" if tracker else "none",
        "maskPath": str(matte_path) if tracker else None,
        "width": out_w,
        "height": out_h,
        "fps": fps,
        "frameCount": n,
        "model": MODEL_NAME[driver_name],
        "driver": driver_name,
        "seed": seed,
        "stats": stats,
    }
