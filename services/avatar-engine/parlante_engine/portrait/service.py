"""Portrait generation job: description -> presenter prompt -> Stable Diffusion -> quality
control (retry with another seed when it fails) -> PNG + provenance sidecar.

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
DEFAULT_STEPS = 20
DEFAULT_GUIDANCE = 5.5
DEFAULT_ATTEMPTS = 3

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


def _record_perf(width: int, height: int, stats: dict, total_s: float, peak_rss_mb: float) -> None:
    with _perf_lock:
        data = load_perf()
        key = f"{width}x{height}"
        entry = {
            "secondsPerUnetEval": stats.get("secondsPerUnetEval"),
            "unetEvals": stats.get("unetEvals"),
            "secondsPerImage": round(total_s, 1),
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

    if key == "512x512" or core_perf.get_metric("secondsPerPortrait") is None:
        core_perf.set_metric("secondsPerPortrait", round(total_s, 1))


def _modelled_eval_seconds(width: int, height: int) -> float:
    n = (width // 8) * (height // 8)
    return _COST_LINEAR * n + _COST_QUADRATIC * n * n


def estimate_seconds(width: int, height: int, steps: int = DEFAULT_STEPS) -> float:
    """Expected seconds for ONE attempt on this machine (measured when available)."""
    perf = load_perf()
    entry = perf.get("sizes", {}).get(f"{width}x{height}")
    if entry and entry.get("secondsPerUnetEval"):
        per_eval = float(entry["secondsPerUnetEval"])
    else:
        per_eval = _modelled_eval_seconds(width, height) * float(perf.get("machineFactor", 1.0))
    return 8.0 + per_eval * steps * 2 + 3.0 * (width * height) / (768 * 768)


def performance_summary() -> dict:
    """Published by GET /health (when the server asks) and by the README numbers."""
    perf = load_perf()
    return {
        "sampler": "dpmpp-2m-karras",
        "defaultSteps": _env_int("AVATAR_ENGINE_PORTRAIT_STEPS", DEFAULT_STEPS, 8, 40),
        "guidance": _env_float("AVATAR_ENGINE_PORTRAIT_GUIDANCE", DEFAULT_GUIDANCE, 1.5, 12.0),
        "maxSide": MAX_SIDE,
        "estimatedSecondsPerImage": {
            "512x512": round(estimate_seconds(512, 512), 0),
            "768x768": round(estimate_seconds(768, 768), 0),
        },
        "measured": perf.get("sizes", {}),
    }


# ---------------------------------------------------------------- pipeline
def pipeline_paths() -> PipelinePaths:
    reg = get_registry()
    return PipelinePaths(
        text_encoder=reg.require(M.TEXT_ENCODER),
        unet_xml=ensure_unet_ir(log.info),
        vae_decoder=reg.require(M.VAE_DECODER),
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
    steps = job.steps or _env_int("AVATAR_ENGINE_PORTRAIT_STEPS", DEFAULT_STEPS, 8, 40)
    guidance = job.guidance or _env_float("AVATAR_ENGINE_PORTRAIT_GUIDANCE", DEFAULT_GUIDANCE, 1.5, 12.0)
    attempts = job.max_attempts or _env_int("AVATAR_ENGINE_PORTRAIT_ATTEMPTS", DEFAULT_ATTEMPTS, 1, 6)
    per_attempt = estimate_seconds(width, height, steps)

    def report(frac: float, eta: float | None) -> None:
        if ctx is not None:
            ctx.progress(frac, eta)

    def cancel_check() -> None:
        if ctx is not None:
            ctx.check_canceled()

    report(0.01, per_attempt + (0 if unet_ir_ready() else 15))
    pipe = PortraitPipeline(pipeline_paths())
    count = pipe.tokenizer.count
    prompt = build_prompt(job.spec, count) if job.spec is not None else \
        prompt_from_description(job.description or "", job.gender, count)
    cancel_check()
    report(0.04, per_attempt)
    # progress share of each attempt: the first one is expected to pass
    shares = [0.86] + [0.08 / max(1, attempts - 1)] * (attempts - 1)
    best: tuple[float, np.ndarray, QcReport, int, int, dict] | None = None
    embeddings = None
    tried = []
    try:
        embeddings = (pipe.encode(prompt.positive), pipe.encode(prompt.negative))
        pipe._text = None                   # noqa: SLF001 - free the text encoder before the UNet loads
        gc.collect()
        base = 0.04
        for k in range(attempts):
            seed_k = attempt_seed(job.seed, k)
            share = shares[k]
            t_attempt = time.perf_counter()

            def on_eval(done: int, total: int, _base=base, _share=share, _t=t_attempt) -> None:
                elapsed = time.perf_counter() - _t
                remaining = elapsed / done * (total - done) + 3.0
                report(_base + _share * 0.95 * done / total, remaining)

            rgb, stats = pipe.generate(prompt.positive, prompt.negative, seed_k, width, height, steps, guidance,
                                       on_eval=on_eval, should_cancel=cancel_check, embeddings=embeddings)
            cancel_check()
            qc = check_portrait(rgb)
            tried.append({"seed": seed_k, "passed": qc.passed, "issues": qc.issues})
            log.info("portrait attempt %d seed %d: %s %s", k + 1, seed_k, "PASS" if qc.passed else "FAIL", qc.issues)
            if best is None or qc.penalty < best[0]:
                best = (qc.penalty, rgb, qc, seed_k, k + 1, stats.to_dict())
            base += share
            if qc.passed:
                break
            if k + 1 < attempts:
                report(base, per_attempt)
    finally:
        pipe.close()
        del pipe
        gc.collect()

    assert best is not None
    _, rgb, qc, seed_used, attempt_no, stats = best
    if qc.face_count != 1 or "face_not_clear" in qc.issues:
        raise EngineError("UNPROCESSABLE", f"No usable portrait after {len(tried)} attempts: the generated images did "
                          "not show exactly one clear face. Rephrase the description or change the seed.",
                          "no_usable_face")
    image_path = job.output_dir / f"{job.file_stem}.png"
    _write_png(image_path, rgb)
    total_s = time.perf_counter() - t_job
    _record_perf(width, height, stats, total_s / len(tried), core_perf.peak_rss_mb())
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
        "steps": steps,
        "guidance": guidance,
        "sampler": "dpmpp-2m-karras",
        "qc": qc.to_dict(),
        "timings": {**stats, "totalSeconds": round(total_s, 1)},
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
