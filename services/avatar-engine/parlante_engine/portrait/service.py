"""Portrait generation job: description -> presenter prompt -> Stable Diffusion -> quality
control (retry with another seed when it fails) -> PNG + provenance sidecar.

Two stages. The model composes presenter portraits much more reliably at its native 512 px
than at 768 px, where it drifts to tilted fashion poses (three seeds in a row failed the
quality control at 768 px for a prompt that passed at 512 px), and even at 512 px the face is
often small in a wider shot. So:
  1. COMPOSITION at <= 512 px, quality-checked; a failed check retries with another seed (cheap).
  2. RE-FRAME + REFINE: the approved composition is cropped to the head-and-shoulders framing
     that `prepare` normalises to, scaled to the requested size and re-rendered by image-to-image
     (noise at half the schedule, same prompt and seed): same person and pose, real detail at
     the final resolution, face large in the frame. The delivered pixels are checked again.

Determinism: attempt k uses seed `seed + k * SEED_STRIDE`, so the same request always produces
the same portrait (the sampler itself is deterministic).
"""
from __future__ import annotations

import gc
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import EngineError
from parlante_engine.core.jobs import JobContext
from parlante_engine.core.registry import get_registry

from . import models as M
from .derive import ensure_unet_ir, unet_ir_ready
from .pipeline import PipelinePaths, PortraitPipeline, round_size
from .prompts import PortraitSpec, PromptPair, build_prompt, prompt_from_description
from .qc import QcReport, check_portrait

log = logging.getLogger("parlante.portrait")

SEED_STRIDE = 1_000_003
MIN_SIDE, MAX_SIDE = 384, 768          # 768 px peaks at ~6.6 GB RSS; larger sizes are not offered
BASE_SIDE = 512                        # the composition is generated with its longest side <= this
REFINE_STRENGTH = 0.5                  # share of the schedule re-run at the target size
# Framing of the delivered portrait = the head-and-shoulders framing `prepare` normalises to
# (measured on its output: forehead-to-chin is ~47 % of the frame, eyes at 42 % of the height).
# Delivering it directly means `prepare` keeps every pixel instead of cropping a small face out
# of a wider shot.
FRAME_FACE_FRACTION = 0.47
FRAME_EYE_LINE = 0.42
# The base model drifts to women: "bearded Middle Eastern man" came out as a woman with four
# seeds out of four and "Japanese man" with two out of three. Weighting the noun's embedding by
# 1.3 fixed both on the failing seeds without changing prompts that already worked.
SUBJECT_EMPHASIS: dict[str, dict[str, float]] = {"male": {"man": 1.3}}
DEFAULT_STEPS = 20
DEFAULT_GUIDANCE = 5.5
DEFAULT_ATTEMPTS = 4
# Measured on the batch that produced the stock library: 10 of 28 compositions passed the quality
# control, i.e. 2.3 compositions per delivered portrait. Estimates use these, not the best case.
ATTEMPT_PASS_RATE = 0.36
EXPECTED_ATTEMPTS = 2.3

# UNet evaluation cost model, fitted to measurements on the build machine (4 cores, OpenVINO):
# 0.65 s at 512x512 and 2.45 s at 768x768 per evaluation; N = latent tokens (w/8 * h/8).
_COST_LINEAR, _COST_QUADRATIC = 7.3e-5, 2.09e-8
_perf_lock = threading.Lock()


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(os.environ.get(name, "").strip() or default)))
    except ValueError:
        return default


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(os.environ.get(name, "").strip() or default)))
    except ValueError:
        return default


@dataclass
class GenerateJob:
    output_dir: Path
    seed: int
    width: int = 512
    height: int = 512
    #: free-text description (HTTP API) …
    description: str | None = None
    gender: str | None = None
    #: … or a structured spec (stock library, Python callers)
    spec: PortraitSpec | None = None
    steps: int | None = None
    guidance: float | None = None
    max_attempts: int | None = None
    file_stem: str = "portrait"


# ---------------------------------------------------------------- measured performance
def _perf_path() -> Path:
    return get_settings().models_dir / ".perf-portrait.json"


def load_perf() -> dict:
    try:
        return json.loads(_perf_path().read_text())
    except (OSError, ValueError):
        return {}


def _record_perf(width: int, height: int, stats: dict, total_s: float | None, peak_rss_mb: float) -> None:
    """Store the measured UNet speed at this size and, when `total_s` is given, the wall time
    of a whole job that DELIVERED this size."""
    with _perf_lock:
        data = load_perf()
        key = f"{width}x{height}"
        previous = data.get("sizes", {}).get(key, {})
        entry = {
            "secondsPerUnetEval": stats.get("secondsPerUnetEval"),
            "unetEvals": stats.get("unetEvals"),
            "secondsPerImage": round(total_s, 1) if total_s is not None else previous.get("secondsPerImage"),
            "peakRssMb": round(peak_rss_mb),
            "loadAvg1": round(os.getloadavg()[0], 2),
            "threads": get_settings().threads,
            "measuredAt": int(time.time()),
        }
        data.setdefault("sizes", {})[key] = entry
        modelled = _modelled_eval_seconds(width, height)
        if entry["secondsPerUnetEval"]:
            data["machineFactor"] = round(entry["secondsPerUnetEval"] / modelled, 3)
        try:
            tmp = _perf_path().with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1))
            os.replace(tmp, _perf_path())
        except OSError:
            pass
    # GET /health publishes `secondsPerPortrait`: the cost of the API's default size (512x512)
    from parlante_engine.core import perf as core_perf

    if total_s is not None and (key == "512x512" or core_perf.get_metric("secondsPerPortrait") is None):
        core_perf.set_metric("secondsPerPortrait", round(total_s, 1))


def _modelled_eval_seconds(width: int, height: int) -> float:
    n = (width // 8) * (height // 8)
    return _COST_LINEAR * n + _COST_QUADRATIC * n * n


def base_size(width: int, height: int) -> tuple[int, int]:
    """Size at which the composition is generated: the target itself up to 512 px, otherwise the
    same aspect ratio with the longest side at 512 px (multiples of 64)."""
    longest = max(width, height)
    if longest <= BASE_SIDE:
        return width, height
    k = BASE_SIDE / longest
    return round_size(int(round(width * k)), MIN_SIDE, BASE_SIDE), round_size(int(round(height * k)), MIN_SIDE, BASE_SIDE)


def presenter_crop(qc: QcReport, width: int, height: int, aspect: float) -> tuple[int, int, int, int] | None:
    """Crop (x0, y0, w, h) of the composition that frames the face as a presenter head-and-
    shoulders shot with the given aspect ratio (w / h), or None when the image already is one.
    The crop never leaves the image: a face too close to an edge is framed as well as possible."""
    if not qc.landmarks5 or "faceHeight" not in qc.metrics or "centerOffset" not in qc.metrics:
        return None
    face_px = float(qc.metrics["faceHeight"]) * height
    eye_y = (qc.landmarks5["leftEye"]["y"] + qc.landmarks5["rightEye"]["y"]) / 2.0 * height
    cx = (0.5 + float(qc.metrics["centerOffset"])) * width
    ch = face_px / FRAME_FACE_FRACTION
    cw = ch * aspect
    k = min(1.0, width / cw, height / ch)
    cw, ch = cw * k, ch * k
    if cw >= 0.94 * width and ch >= 0.94 * height:
        return None
    x0 = min(max(cx - cw / 2.0, 0.0), width - cw)
    y0 = min(max(eye_y - FRAME_EYE_LINE * ch, 0.0), height - ch)
    return int(round(x0)), int(round(y0)), int(round(cw)), int(round(ch))


def refine_steps(steps: int) -> int:
    """Sampler steps actually run by the high-resolution pass."""
    return steps - int(min(steps - 1, max(0, round(steps * (1.0 - REFINE_STRENGTH)))))


def _eval_seconds(width: int, height: int) -> float:
    perf = load_perf()
    entry = perf.get("sizes", {}).get(f"{width}x{height}")
    if entry and entry.get("secondsPerUnetEval"):
        return float(entry["secondsPerUnetEval"])
    return _modelled_eval_seconds(width, height) * float(perf.get("machineFactor", 1.0))


def estimate_stage_seconds(width: int, height: int, steps: int = DEFAULT_STEPS) -> tuple[float, float]:
    """(seconds of ONE composition attempt, seconds of the high-resolution pass or 0) on this
    machine, from measurements when available."""
    bw, bh = base_size(width, height)
    attempt = _eval_seconds(bw, bh) * steps * 2 + 2.5 * (bw * bh) / (512 * 512)
    # the second pass runs whenever the composition is re-framed or enlarged: nearly always
    refine = _eval_seconds(width, height) * refine_steps(steps) * 2 + 4.0 * (width * height) / (512 * 512)
    return attempt, refine


def estimate_seconds(width: int, height: int, steps: int = DEFAULT_STEPS, attempts: int = DEFAULT_ATTEMPTS) -> float:
    """Expected seconds of a job on this machine, counting the compositions that the quality
    control typically rejects (a first-attempt pass is faster, four attempts slower)."""
    attempt, refine = estimate_stage_seconds(width, height, steps)
    return 6.0 + attempt * min(EXPECTED_ATTEMPTS, float(attempts)) + refine


def performance_summary() -> dict:
    """Published by GET /v1/portraits/options: what a client needs to give an honest estimate
    BEFORE queueing a job (measured on this machine when a job of that size has run)."""
    perf = load_perf()
    steps = _env_int("AVATAR_ENGINE_PORTRAIT_STEPS", DEFAULT_STEPS, 8, 40)
    attempts = _env_int("AVATAR_ENGINE_PORTRAIT_ATTEMPTS", DEFAULT_ATTEMPTS, 1, 6)
    return {
        "sampler": "dpmpp-2m-karras",
        "steps": steps,
        "guidance": _env_float("AVATAR_ENGINE_PORTRAIT_GUIDANCE", DEFAULT_GUIDANCE, 1.5, 12.0),
        "maxAttempts": attempts,
        # typical job (2.3 compositions per portrait) and the best case (first attempt passes)
        "estimatedSeconds": {f"{side}x{side}": round(estimate_seconds(side, side, steps, attempts))
                             for side in (512, 640, 768)},
        "bestCaseSeconds": {f"{side}x{side}": round(estimate_seconds(side, side, steps, 1)) for side in (512, 640, 768)},
        "measured": perf.get("sizes", {}),
    }


# ---------------------------------------------------------------- pipeline
def pipeline_paths() -> PipelinePaths:
    reg = get_registry()
    return PipelinePaths(
        text_encoder=reg.require(M.TEXT_ENCODER),
        unet_xml=ensure_unet_ir(log.info),
        vae_decoder=reg.require(M.VAE_DECODER),
        vae_encoder=reg.require(M.VAE_ENCODER),
        vocab=reg.require(M.VOCAB),
        merges=reg.require(M.MERGES),
    )


def attempt_seed(seed: int, attempt: int) -> int:
    return int(seed) + attempt * SEED_STRIDE


def _write_png(path: Path, rgb: np.ndarray) -> None:
    ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    if not ok:
        raise EngineError("INTERNAL", "Could not encode the generated portrait.", "encode_failed")
    tmp = path.with_suffix(".png.tmp")
    tmp.write_bytes(buf.tobytes())
    os.replace(tmp, path)


def run_generate(job: GenerateJob, ctx: JobContext | None = None) -> dict:
    """Runs inside the engine job queue (or directly). Returns the `generate` result of the
    contract plus additive provenance fields."""
    from parlante_engine.core import perf as core_perf

    t_job = time.perf_counter()
    # validates the request (cheap) before any model is loaded; rebuilt below with real token counts
    prompt: PromptPair = build_prompt(job.spec) if job.spec is not None else \
        prompt_from_description(job.description or "", job.gender)
    width, height = round_size(job.width, MIN_SIDE, MAX_SIDE), round_size(job.height, MIN_SIDE, MAX_SIDE)
    bw, bh = base_size(width, height)
    two_stage = (bw, bh) != (width, height)
    steps = job.steps or _env_int("AVATAR_ENGINE_PORTRAIT_STEPS", DEFAULT_STEPS, 8, 40)
    guidance = job.guidance or _env_float("AVATAR_ENGINE_PORTRAIT_GUIDANCE", DEFAULT_GUIDANCE, 1.5, 12.0)
    attempts = job.max_attempts or _env_int("AVATAR_ENGINE_PORTRAIT_ATTEMPTS", DEFAULT_ATTEMPTS, 1, 6)
    est_attempt, est_refine = estimate_stage_seconds(width, height, steps)

    def report(frac: float, eta: float | None) -> None:
        if ctx is not None:
            ctx.progress(frac, eta)

    def cancel_check() -> None:
        if ctx is not None:
            ctx.check_canceled()

    typical = est_attempt * min(EXPECTED_ATTEMPTS, float(attempts)) + est_refine
    report(0.01, typical + (6 if unet_ir_ready() else 20))
    pipe = PortraitPipeline(pipeline_paths())
    count = pipe.tokenizer.count
    prompt = build_prompt(job.spec, count) if job.spec is not None else \
        prompt_from_description(job.description or "", job.gender, count)
    cancel_check()
    report(0.03, typical)
    # progress: composition attempts share [0.03, compose_end] (the first is expected to pass),
    # the high-resolution pass takes the rest
    compose_end = 0.03 + 0.94 * est_attempt / (est_attempt + est_refine)
    first_share = (compose_end - 0.03) * (0.9 if attempts > 1 else 1.0)
    shares = [first_share] + [(compose_end - 0.03 - first_share) / max(1, attempts - 1)] * (attempts - 1)
    best: tuple[float, np.ndarray, QcReport, int, dict] | None = None
    tried = []
    stage_stats: dict = {}
    evals_done = {"n": 0}
    try:
        embeddings = (pipe.encode(prompt.positive, SUBJECT_EMPHASIS.get(prompt.gender)),
                      pipe.encode(prompt.negative))
        pipe._text = None                   # noqa: SLF001 - free the text encoder before the UNet loads
        gc.collect()
        start = 0.03
        for k in range(attempts):
            seed_k = attempt_seed(job.seed, k)
            share = shares[k]
            t_attempt = time.perf_counter()

            # a retry is more likely than not while attempts remain: the ETA counts its expected cost
            retry_cost = (1.0 - ATTEMPT_PASS_RATE) * est_attempt if k + 1 < attempts else 0.0

            def on_eval(done: int, total: int, _start=start, _share=share, _t=t_attempt, _retry=retry_cost) -> None:
                per_eval = (time.perf_counter() - _t) / done
                report(_start + _share * done / total, per_eval * (total - done) + 2.0 + _retry + est_refine)

            rgb, stats = pipe.generate(prompt.positive, prompt.negative, seed_k, bw, bh, steps, guidance,
                                       on_eval=on_eval, should_cancel=cancel_check, embeddings=embeddings)
            cancel_check()
            qc = check_portrait(rgb)
            tried.append({"seed": seed_k, "passed": qc.passed, "issues": qc.issues})
            log.info("portrait attempt %d seed %d at %dx%d: %s %s", k + 1, seed_k, bw, bh,
                     "PASS" if qc.passed else "FAIL", qc.issues)
            evals_done["n"] += stats.unet_evals
            if best is None or qc.penalty < best[0]:
                best = (qc.penalty, rgb, qc, seed_k, stats.to_dict())
            start += share
            if qc.passed:
                break
            if k + 1 < attempts:
                report(start, est_attempt + est_refine + (retry_cost if k + 2 < attempts else 0.0))
        assert best is not None
        _, rgb, qc, seed_used, stage_stats = best
        if qc.face_count != 1 or "face_not_clear" in qc.issues:
            raise EngineError("UNPROCESSABLE", f"No usable portrait after {len(tried)} attempts: the generated "
                              "images did not show exactly one clear face. Rephrase the description or change "
                              "the seed.", "no_usable_face")
        compose_qc = qc
        refine_stats = None
        crop = presenter_crop(qc, bw, bh, width / height)
        if two_stage or crop is not None:
            t_refine = time.perf_counter()
            source = rgb if crop is None else rgb[crop[1]:crop[1] + crop[3], crop[0]:crop[0] + crop[2]]
            interp = cv2.INTER_LANCZOS4 if source.shape[0] < height else cv2.INTER_AREA
            upscaled = cv2.resize(np.ascontiguousarray(source), (width, height), interpolation=interp)

            def on_refine(done: int, total: int) -> None:
                per_eval = (time.perf_counter() - t_refine) / done
                report(compose_end + (0.97 - compose_end) * done / total, per_eval * (total - done) + 3.0)

            report(compose_end, est_refine)
            rgb, stats = pipe.generate(prompt.positive, prompt.negative, seed_used, width, height, steps, guidance,
                                       on_eval=on_refine, should_cancel=cancel_check, embeddings=embeddings,
                                       init_image=upscaled, strength=REFINE_STRENGTH, release_unet=True)
            cancel_check()
            refine_stats = stats.to_dict()
            qc = check_portrait(rgb)            # the delivered pixels are the ones that count
            log.info("portrait refined to %dx%d: %s %s", width, height, "PASS" if qc.passed else "FAIL", qc.issues)
            if qc.face_count != 1 or "face_not_clear" in qc.issues:
                raise EngineError("UNPROCESSABLE", "The high-resolution pass did not keep a clear face. Change the "
                                  "seed or request a 512-pixel portrait.", "no_usable_face")
    finally:
        pipe.close()
        del pipe
        gc.collect()

    image_path = job.output_dir / f"{job.file_stem}.png"
    _write_png(image_path, rgb)
    total_s = time.perf_counter() - t_job
    _record_perf(bw, bh, stage_stats, total_s if (width, height) == (bw, bh) else None, core_perf.peak_rss_mb())
    if refine_stats is not None and (width, height) != (bw, bh):
        _record_perf(width, height, refine_stats, total_s, core_perf.peak_rss_mb())
    meta = {
        "synthetic": True,
        "model": M.MODEL_NAME,
        "license": M.LICENSE,
        "description": job.description,
        "prompt": prompt.positive,
        "negativePrompt": prompt.negative,
        "seed": int(job.seed),
        "seedUsed": seed_used,
        "attempts": tried,
        "width": width,
        "height": height,
        "compositionSize": [bw, bh],
        "compositionCrop": list(crop) if crop is not None else None,
        "steps": steps,
        "guidance": guidance,
        "sampler": "dpmpp-2m-karras",
        "emphasis": SUBJECT_EMPHASIS.get(prompt.gender),
        "refineStrength": REFINE_STRENGTH if refine_stats is not None else None,
        "qc": qc.to_dict(),
        "compositionQc": compose_qc.to_dict() if refine_stats is not None else None,
        "timings": {"composition": stage_stats, "refine": refine_stats, "totalSeconds": round(total_s, 1),
                    "peakRssMb": round(core_perf.peak_rss_mb())},
    }
    (job.output_dir / f"{job.file_stem}.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    report(0.99, 0.0)
    return {
        "kind": "generate",
        "imagePath": str(image_path),
        "model": M.MODEL_NAME,
        # additive fields (optional in the shared schema)
        "width": width,
        "height": height,
        "seedUsed": seed_used,
        "attempts": len(tried),
        "qcPassed": qc.passed,
        "qcIssues": qc.issues,
    }
