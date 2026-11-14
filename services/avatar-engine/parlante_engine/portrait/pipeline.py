"""Text -> image with Stable Diffusion 1.5 on CPU, without torch.

Our own inference code around plain graphs executed by OpenVINO:
  CLIP text encoder (ONNX)  ->  UNet (OpenVINO IR derived from the ONNX, FP16-compressed
  weights)  ->  VAE decoder (ONNX)
Sampler: DPM-Solver++(2M) with Karras sigmas and classifier-free guidance (the negative prompt
is what keeps mouths closed and backgrounds plain, so guidance is always on).

Everything is deterministic for a given (prompt, negative, seed, size, steps, guidance): the
initial noise comes from numpy's PCG64 seeded with `seed`, and the sampler adds no noise.
"""
from __future__ import annotations

import gc
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from parlante_engine.core.config import get_settings

from .tokenizer import ClipTokenizer

VAE_SCALE = 0.18215
LATENT_DOWN = 8


@dataclass
class PipelinePaths:
    text_encoder: Path
    unet_xml: Path
    vae_decoder: Path
    vocab: Path
    merges: Path


@dataclass
class GenStats:
    text_s: float = 0.0
    load_s: float = 0.0
    unet_s: float = 0.0
    vae_s: float = 0.0
    unet_evals: int = 0
    eval_s: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "loadSeconds": round(self.load_s, 2),
            "textSeconds": round(self.text_s, 2),
            "unetSeconds": round(self.unet_s, 2),
            "vaeSeconds": round(self.vae_s, 2),
            "unetEvals": self.unet_evals,
            "secondsPerUnetEval": round(self.unet_s / self.unet_evals, 3) if self.unet_evals else None,
        }


def alphas_cumprod() -> np.ndarray:
    """SD 1.x training schedule: scaled-linear betas, 1000 steps."""
    betas = np.linspace(0.00085 ** 0.5, 0.012 ** 0.5, 1000, dtype=np.float64) ** 2
    return np.cumprod(1.0 - betas)


def karras_sigmas(steps: int, rho: float = 7.0) -> np.ndarray:
    """`steps` sigmas from the schedule's maximum to its minimum, followed by 0."""
    ac = alphas_cumprod()
    all_sigmas = np.sqrt((1 - ac) / ac)
    smin, smax = all_sigmas[0], all_sigmas[-1]
    ramp = np.linspace(0, 1, steps)
    sig = (smax ** (1 / rho) + ramp * (smin ** (1 / rho) - smax ** (1 / rho))) ** rho
    return np.append(sig, 0.0)


def sigma_to_timestep(sigma: float) -> int:
    ac = alphas_cumprod()
    log_all = np.log(np.sqrt((1 - ac) / ac))
    return int(np.round(np.interp(np.log(sigma), log_all, np.arange(1000))))


def dpmpp_2m(denoise: Callable[[np.ndarray, float], np.ndarray], x: np.ndarray, sigmas: np.ndarray,
             on_step: Callable[[int, int], None] | None = None) -> np.ndarray:
    """DPM-Solver++(2M), data prediction. `denoise(x, sigma)` returns the predicted clean latent."""
    old = None
    n = len(sigmas) - 1
    for i in range(n):
        s, sn = sigmas[i], sigmas[i + 1]
        den = denoise(x, s)
        if sn == 0:
            x = den
        else:
            t, tn = -np.log(s), -np.log(sn)
            h = tn - t
            if old is None:
                x = (sn / s) * x - np.expm1(-h) * den
            else:
                r = (t - (-np.log(sigmas[i - 1]))) / h
                d = (1 + 1 / (2 * r)) * den - (1 / (2 * r)) * old
                x = (sn / s) * x - np.expm1(-h) * d
        old = den
        if on_step:
            on_step(i + 1, n)
    return x


def round_size(value: int, lo: int = 384, hi: int = 1024) -> int:
    """Sizes the UNet supports: multiples of 64 inside [lo, hi]."""
    return int(min(hi, max(lo, round(value / 64) * 64)))


class PortraitPipeline:
    """Compiled models. Not thread-safe: the job queue runs one job at a time."""

    def __init__(self, paths: PipelinePaths, threads: int | None = None):
        import openvino as ov

        s = get_settings()
        self.paths = paths
        self._ov = ov
        self._core = ov.Core()
        self._cfg: dict = {"INFERENCE_NUM_THREADS": threads or s.threads, "PERFORMANCE_HINT": "LATENCY"}
        if s.precision in ("f32", "bf16"):
            self._cfg["INFERENCE_PRECISION_HINT"] = s.precision
        self.tokenizer = ClipTokenizer(paths.vocab, paths.merges)
        self._text = None
        self._unet = None
        self._vae = None
        self._t_dtype = np.float32
        self._t_scalar = True
        self.load_s = 0.0

    # ---------------------------------------------------------------- models
    def _compile(self, path: Path):
        t = time.perf_counter()
        model = self._core.read_model(str(path))
        compiled = self._core.compile_model(model, "CPU", self._cfg)
        self.load_s += time.perf_counter() - t
        return model, compiled

    def _text_encoder(self):
        if self._text is None:
            _, self._text = self._compile(self.paths.text_encoder)
        return self._text

    def _unet_model(self):
        if self._unet is None:
            model, self._unet = self._compile(self.paths.unet_xml)
            ti = next(i for i in model.inputs if "timestep" in i.get_names())
            self._t_dtype = np.int64 if "i64" in str(ti.get_element_type()) else np.float32
            self._t_scalar = ti.get_partial_shape().rank.get_length() == 0
        return self._unet

    def _vae_decoder(self):
        if self._vae is None:
            _, self._vae = self._compile(self.paths.vae_decoder)
        return self._vae

    def close(self) -> None:
        self._text = self._unet = self._vae = None
        gc.collect()

    # ---------------------------------------------------------------- stages
    def encode(self, prompt: str) -> np.ndarray:
        """[1, 77 * n_windows, 768] text embeddings."""
        te = self._text_encoder()
        port = te.inputs[0]
        windows = self.tokenizer.windows(prompt)
        dtype = np.int32 if "i32" in str(port.get_element_type()) else np.int64
        chunks = [np.array(te({port: w[None].astype(dtype)})[0]) for w in windows]
        return np.concatenate(chunks, axis=1).astype(np.float32)

    def _eps(self, x: np.ndarray, t: int, emb: np.ndarray) -> np.ndarray:
        tt = np.array(t, self._t_dtype) if self._t_scalar else np.array([t], self._t_dtype)
        out = self._unet({"sample": x.astype(np.float32), "timestep": tt, "encoder_hidden_states": emb})
        return np.array(out[0]).astype(np.float64)

    def decode(self, latent: np.ndarray) -> np.ndarray:
        vae = self._vae_decoder()
        img = np.array(vae({vae.inputs[0]: (latent / VAE_SCALE).astype(np.float32)})[0])[0]
        return ((img.transpose(1, 2, 0) / 2 + 0.5).clip(0, 1) * 255).round().astype(np.uint8)

    # ---------------------------------------------------------------- generate
    def generate(self, positive: str, negative: str, seed: int, width: int, height: int, steps: int = 20,
                 guidance: float = 5.5, on_eval: Callable[[int, int], None] | None = None,
                 should_cancel: Callable[[], None] | None = None,
                 embeddings: tuple[np.ndarray, np.ndarray] | None = None) -> tuple[np.ndarray, GenStats]:
        """RGB uint8 [height, width, 3]. `on_eval(done, total)` is called after every UNet
        evaluation (2 per step); `should_cancel()` may raise to abort between evaluations."""
        st = GenStats()
        load0 = self.load_s
        t0 = time.perf_counter()
        if embeddings is None:
            cond, uncond = self.encode(positive), self.encode(negative)
            # the text encoder is not needed again for this image: release its memory
            self._text = None
        else:
            cond, uncond = embeddings
        st.text_s = time.perf_counter() - t0
        self._unet_model()
        total_evals = steps * 2
        sigmas = karras_sigmas(steps)
        rng = np.random.default_rng(int(seed))
        x = rng.standard_normal((1, 4, height // LATENT_DOWN, width // LATENT_DOWN)) * np.sqrt(sigmas[0] ** 2 + 1)

        def denoise(x: np.ndarray, sigma: float) -> np.ndarray:
            t = sigma_to_timestep(sigma)
            scaled = x / np.sqrt(sigma ** 2 + 1)
            eps = []
            for emb in (uncond, cond):
                if should_cancel:
                    should_cancel()
                t1 = time.perf_counter()
                eps.append(self._eps(scaled, t, emb))
                st.eval_s.append(time.perf_counter() - t1)
                st.unet_evals += 1
                if on_eval:
                    on_eval(st.unet_evals, total_evals)
            e = eps[0] + guidance * (eps[1] - eps[0])
            return x - sigma * e

        t1 = time.perf_counter()
        x = dpmpp_2m(denoise, x, sigmas)
        st.unet_s = time.perf_counter() - t1
        if should_cancel:
            should_cancel()
        t2 = time.perf_counter()
        img = self.decode(x)
        st.vae_s = time.perf_counter() - t2
        st.load_s = self.load_s - load0
        return img, st
