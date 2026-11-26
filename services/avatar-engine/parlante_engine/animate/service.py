"""Animation job: prepared portrait + audio (+ viseme timeline) -> clip + matte clip."""
from __future__ import annotations

import hashlib
import json
import logging
import math
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
    #: None = legacy rule (timeline when given, else audio) | "auto" = best available | "visemes" | "audio"
    driver: str | None = None
    seed: int | None = None
    max_frames: int | None = None   # benchmark / tests only
    #: Audio driver only: "lips" (lips from the audio model, the rest from the seeded rig) | "full".
    audio_motion: str | None = None
    audio_lip_gain: float | None = None
    audio_lip_advance_ms: float | None = None
    #: "calibrated" (default) | "raw" (the audio model's lip displacement as is; comparisons only)
    audio_lip_drive: str = "calibrated"


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


#: Bump when the pixels produced for the same request change (driver logic, tuning defaults):
#: it is part of `animation.key` in /health, which clients put in their clip-cache keys.
ANIMATION_REVISION = 5
#: Free memory the audio driver needs on top of the running engine (HuBERT is 1.46 GB on disk;
#: measured: +2.0 GB of resident memory while it extracts features).
AUDIO_DRIVER_FREE_MB = 2500
#: `auto` in "fit" mode keeps the viseme timeline only when it follows the sound clearly better
#: than the audio-driven lips do (difference of the two correlations with the loudness).
FIT_MARGIN = 0.05
#: A viseme timeline whose mouth track correlates at least this much with the loudness is taken
#: as exact (measured: 0.53-0.56 for eSpeak's phoneme events, 0.14-0.19 for a timeline that runs
#: 50-200 ms late): the audio driver then closes the lips on its /p b m/ instants as given.
TIMELINE_TRUST_FIT = 0.4
#: Below this peak (-60 dBFS) a narration is silence: nothing to lip-sync.
SILENCE_PEAK = 1e-3


def resolve_driver(requested: str | None, has_visemes: bool, audio_ready: bool, auto_driver: str = "fit",
                   free_mb: float | None = None, silent: bool = False) -> tuple[str, str]:
    """Which driver animates a request -> (driver, why).

      "visemes" / "audio"  explicit: honoured (the caller is told when it cannot be)
      "auto"               the best available. With both drivers usable the engine's preference
                           decides (AVATAR_ENGINE_AUTO_DRIVER): "fit" = build both mouth tracks and
                           keep the one that follows the sound of THIS clip better (answer "fit":
                           the caller measures); "audio" / "visemes" = always that one. It never
                           fails because an OPTIONAL model is missing, and a silent clip never
                           loads the audio model.
      None                 the field was not sent: the rule older clients rely on — the viseme
                           timeline when there is one, the audio model otherwise.
    """
    if requested == "visemes":
        if not has_visemes:
            raise EngineError("VALIDATION_ERROR", "driver 'visemes' needs a viseme timeline.", "visemes_required")
        return "visemes", "requested"
    if requested == "audio":
        return "audio", "requested"
    if requested == "auto":
        if silent:
            return "visemes", "silent"                 # mouth at rest, seeded blinks and head motion
        if not has_visemes:
            return "audio", "no_timeline"
        if auto_driver == "visemes":
            return "visemes", "preferred"
        if not audio_ready:
            return "visemes", "audio_weights_missing"
        if free_mb is not None and free_mb < AUDIO_DRIVER_FREE_MB:
            return "visemes", "low_memory"
        return ("audio", "preferred") if auto_driver == "audio" else ("fit", "compare")
    return ("visemes", "legacy_timeline") if has_visemes else ("audio", "legacy_no_timeline")


def loudness_fit(track: np.ndarray, wav16k: np.ndarray, fps: float) -> float | None:
    """How well a per-frame mouth-opening track follows the sound: Pearson correlation with the
    RMS loudness of each frame's audio (no lag allowed: a late timeline must score low)."""
    n = len(track)
    hop = 16000.0 / fps
    env = np.array([math.sqrt(float(np.mean(wav16k[int(i * hop):int((i + 1) * hop)] ** 2)) + 1e-12)
                    if int(i * hop) < len(wav16k) else 0.0 for i in range(n)])
    track = np.asarray(track, np.float64)
    if n < 8 or track.std() < 1e-6 or env.std() < 1e-9:
        return None
    return float(np.corrcoef(track, env)[0, 1])


def pick_by_fit(fit_visemes: float | None, fit_audio: float | None) -> tuple[str, str]:
    """`auto` in "fit" mode: the timeline wins only when it tracks the sound clearly better."""
    if fit_visemes is None or fit_audio is None:
        return "audio", "fit_undefined"
    if fit_visemes > fit_audio + FIT_MARGIN:
        return "visemes", "fit_timeline_follows_sound_better"
    return "audio", "fit_audio_follows_sound_better"


def wav_is_silent(path: Path) -> bool:
    return float(np.abs(decode_audio(path, 16000)).max(initial=0.0)) < SILENCE_PEAK


def choose_driver(job: AnimateJob) -> str:
    return choose_driver_with_reason(job)[0]


def choose_driver_with_reason(job: AnimateJob) -> tuple[str, str]:
    auto = job.driver == "auto"
    return resolve_driver(job.driver, bool(job.visemes), get_registry().capability_ready("animate-audio"),
                          get_settings().auto_driver, perf.available_mb() if auto else None,
                          silent=auto and wav_is_silent(job.audio_path))


def animation_info() -> dict:
    """`animation` of GET /health: what "auto" resolves to (for a spoken request with a timeline)
    and a key that changes whenever the same request would produce different pixels. In "fit"
    mode the driver is decided per clip: `autoDriver` then names the audio driver, which is the
    one that has to be available for the comparison, and the key says "fit"."""
    s = get_settings()
    driver, _ = resolve_driver("auto", True, get_registry().capability_ready("animate-audio"), s.auto_driver)
    if driver == "visemes":
        return {"autoDriver": "visemes", "key": f"visemes.r{ANIMATION_REVISION}"}
    tuning = f"{s.audio_motion}.g{s.audio_lip_gain:g}.a{s.audio_lip_advance_ms:g}"
    return {"autoDriver": "audio", "key": f"{'fit' if driver == 'fit' else 'audio'}-{tuning}.r{ANIMATION_REVISION}"}


def run_animation(job: AnimateJob, ctx: JobContext | None = None) -> dict:
    """Runs inside the job worker. Returns the `animate` result of the HTTP contract plus a
    `stats` object with the measurements of this very run."""
    t_start = time.monotonic()
    reg = get_registry()
    peak = [perf.rss_mb()]

    def sample_rss() -> None:
        peak[0] = max(peak[0], perf.rss_mb())

    if not reg.capability_ready("animate"):
        raise EngineError("SERVICE_UNAVAILABLE", "Animation weights are missing. Run scripts/download_models.py.",
                          "weights_missing")
    driver_name, driver_reason = choose_driver_with_reason(job)
    if driver_name == "audio" and not reg.capability_ready("animate-audio"):
        raise EngineError("SERVICE_UNAVAILABLE", "The audio-driven model is not downloaded "
                          "(run scripts/download_models.py) and this request cannot be animated without it.",
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
    uses_audio_model = driver_name in ("audio", "fit")
    spf_hint = perf.seconds_per_frame("audio" if uses_audio_model else "visemes") or perf.seconds_per_frame("visemes")
    if ctx:
        ctx.progress(0.0, spf_hint * n if spf_hint else None)

    engine = get_engine()
    bgr = read_portrait(job.portrait_path)
    avatar = load_avatar(job.portrait_path, bgr)
    seed = job.seed if job.seed is not None else default_seed(job, avatar.portrait_sha256)
    if ctx:
        ctx.check_canceled()

    from .drivers import AudioDriver, VisemeDriver
    setup_span = 0.12 if uses_audio_model else 0.02
    fit: dict | None = None
    if not uses_audio_model:
        driver = VisemeDriver(engine, avatar, job.visemes or [], duration * 1000.0, fps, seed, job.words, n_total)
    else:
        def on_stage(stage: str, frac: float) -> None:
            sample_rss()
            if ctx:
                base = 0.0 if stage == "features" else setup_span * 0.3
                span = setup_span * (0.3 if stage == "features" else 0.7)
                ctx.progress(base + span * frac, (spf_hint * n) if spf_hint else None)

        wav = decode_audio(job.audio_path, 16000)
        fit_visemes = loudness_fit(C.mouth_tracks(job.visemes, duration * 1000.0, fps, n_frames=n_total)[:, 0],
                                   wav, fps) if job.visemes else None
        driver = AudioDriver(engine, avatar, wav, fps, seed, n_total, job.visemes, on_stage=on_stage,
                             check_canceled=ctx.check_canceled if ctx else None, words=job.words,
                             motion_mode=job.audio_motion or get_settings().audio_motion,
                             lip_gain=get_settings().audio_lip_gain if job.audio_lip_gain is None
                             else job.audio_lip_gain,
                             lip_advance_ms=get_settings().audio_lip_advance_ms
                             if job.audio_lip_advance_ms is None else job.audio_lip_advance_ms,
                             lip_drive=job.audio_lip_drive,
                             timeline_trusted=fit_visemes is not None and fit_visemes >= TIMELINE_TRUST_FIT)
        if driver_name == "fit":
            # `auto`: both mouth tracks are measured against the sound of this clip; the audio
            # model has just run, so keeping its result costs nothing more.
            opening = getattr(driver, "lip_ratio", None)
            fit_audio = loudness_fit(opening if opening is not None else driver.opening, wav, fps)
            driver_name, driver_reason = pick_by_fit(fit_visemes, fit_audio)
            fit = {"visemes": None if fit_visemes is None else round(fit_visemes, 3),
                   "audio": None if fit_audio is None else round(fit_audio, 3), "margin": FIT_MARGIN}
            audio_timings, audio_backends = driver.timings, driver.backends
            if driver_name == "visemes":
                del driver
                driver = VisemeDriver(engine, avatar, job.visemes or [], duration * 1000.0, fps, seed, job.words,
                                      n_total)
                driver.timings, driver.backends = audio_timings, audio_backends

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
    load0 = perf.load_avg()
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
        "driver": driver_name, "driverRequested": job.driver, "driverReason": driver_reason,
        "seed": seed, "frames": n, "secondsPerFrame": round(spf, 4),
        "renderSeconds": round(loop_s, 2), "setupSeconds": round(t_setup, 2),
        "totalSeconds": round(time.monotonic() - t_start, 2), "loadAvgStart": round(load0, 2),
        "loadAvgEnd": round(perf.load_avg(), 2), "peakRssMb": round(peak[0], 0),
        "processPeakRssMb": round(perf.peak_rss_mb(), 0),
        "backend": engine.generator.backend, "framesSha256": digest.hexdigest(),
    }
    if fit is not None:
        stats["fit"] = fit                       # correlation of each mouth track with the loudness
    elif uses_audio_model and fit_visemes is not None:
        stats["fit"] = {"visemes": round(fit_visemes, 3)}
    if uses_audio_model:
        stats["audioSetupSeconds"] = driver.timings
    if driver_name == "audio":
        stats["audioMotion"] = driver.motion_mode
        stats["audioLipDrive"] = driver.lip_drive
        stats["audioArticulationGain"] = round(float(getattr(driver, "articulation", 1.0)), 3)
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
