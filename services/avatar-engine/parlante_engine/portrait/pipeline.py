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
    #: needed only by the high-resolution pass (image-to-image)
    vae_encoder: Path | None = None


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
        self._text_input: tuple[str, type] = ("input_ids", np.int64)
        self._vae_input = "latent_sample"
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

    # NOTE: models are always fed by tensor NAME. Calling a CompiledModel with port objects
    # (`compiled({compiled.inputs[0]: x})`) keeps it alive after its last reference is dropped
    # (openvino 2026.4, measured: +0.9 GB per job for the text encoder alone, which got a
    # long batch run killed by the OOM killer). `InferRequest.infer` with ports does not.
    @staticmethod
    def _input(model, index: int = 0) -> tuple[str, type]:
        port = model.inputs[index]
        return port.get_any_name(), (np.int32 if "i32" in str(port.get_element_type()) else
                                     np.int64 if "i64" in str(port.get_element_type()) else np.float32)

    def _text_encoder(self):
        if self._text is None:
            model, self._text = self._compile(self.paths.text_encoder)
            self._text_input = self._input(model)
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
            model, self._vae = self._compile(self.paths.vae_decoder)
            self._vae_input = self._input(model)[0]
        return self._vae

    def close(self) -> None:
        self._text = self._unet = self._vae = None
        gc.collect()

    # ---------------------------------------------------------------- stages
    def encode(self, prompt: str, emphasis: dict[str, float] | None = None) -> np.ndarray:
        """[1, 77, 768] text embeddings (one CLIP window; see tokenizer.py).

        `emphasis` maps words of the prompt to a weight: the embeddings at the positions of
        those tokens are multiplied by it and the tensor is rescaled to its original mean (the
        usual prompt-weighting scheme). Used sparingly: 1.3 on one word is safe, 1.8 on two
        words produced broken images in our tests."""
        te = self._text_encoder()
        name, dtype = self._text_input
        ids = self.tokenizer.encode(prompt)
        emb = np.array(te({name: ids.astype(dtype)})[0]).astype(np.float32)
        if emphasis:
            mean = float(emb.mean())
            row = [int(t) for t in ids[0]]
            for word, weight in emphasis.items():
                target = self.tokenizer.ids(word)
                n = len(target)
                for pos in range(1, len(row) - n + 1):
                    if n and row[pos: pos + n] == target:
                        emb[0, pos: pos + n] *= float(weight)
            if abs(float(emb.mean())) > 1e-12:
                emb *= mean / float(emb.mean())
        return emb

    def _eps(self, x: np.ndarray, t: int, emb: np.ndarray) -> np.ndarray:
        tt = np.array(t, self._t_dtype) if self._t_scalar else np.array([t], self._t_dtype)
        out = self._unet({"sample": x.astype(np.float32), "timestep": tt, "encoder_hidden_states": emb})
        return np.array(out[0]).astype(np.float64)

    def encode_image(self, rgb: np.ndarray) -> np.ndarray:
        """RGB uint8 [H, W, 3] -> scaled latent [1, 4, H/8, W/8] (the posterior MEAN: deterministic).
        The encoder is compiled for the call and released: it is used once or twice per job."""
        if self.paths.vae_encoder is None:
            raise RuntimeError("the VAE encoder is not available")
        model, encoder = self._compile(self.paths.vae_encoder)
        name = self._input(model)[0]
        del model
        x = (rgb.astype(np.float32) / 127.5 - 1.0).transpose(2, 0, 1)[None]
        params = np.array(encoder({name: np.ascontiguousarray(x)})[0])
        del encoder
        return params[:, :4].astype(np.float64) * VAE_SCALE

    def decode(self, latent: np.ndarray) -> np.ndarray:
        vae = self._vae_decoder()
        img = np.array(vae({self._vae_input: (latent / VAE_SCALE).astype(np.float32)})[0])[0]
        return ((img.transpose(1, 2, 0) / 2 + 0.5).clip(0, 1) * 255).round().astype(np.uint8)

    # ---------------------------------------------------------------- generate
    def generate(self, positive: str, negative: str, seed: int, width: int, height: int, steps: int = 20,
                 guidance: float = 5.5, on_eval: Callable[[int, int], None] | None = None,
                 should_cancel: Callable[[], None] | None = None,
                 embeddings: tuple[np.ndarray, np.ndarray] | None = None,
                 init_image: np.ndarray | None = None, strength: float = 1.0,
                 release_unet: bool = False) -> tuple[np.ndarray, GenStats]:
        """RGB uint8 [height, width, 3].

        `init_image` (RGB uint8, same size) + `strength` in (0, 1]: start from that image noised
        to the sigma at `1 - strength` of the schedule and run only the remaining steps
        (image-to-image). `strength` 1 with an init image still runs every step but keeps the
        image's low frequencies in the starting latent.
        `release_unet`: free the UNet before decoding (the last image of a job): the VAE decoder
        needs ~1 GB of activations at 768 px and the peak RSS is what limits the image size.
        `on_eval(done, total)` is called after every UNet evaluation (2 per step);
        `should_cancel()` may raise to abort between evaluations."""
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
        sigmas = karras_sigmas(steps)
        rng = np.random.default_rng(int(seed))
        noise = rng.standard_normal((1, 4, height // LATENT_DOWN, width // LATENT_DOWN))
        if init_image is None:
            x = noise * np.sqrt(sigmas[0] ** 2 + 1)
        else:
            if init_image.shape[:2] != (height, width):
                raise ValueError("init_image must have the requested size")
            first = int(min(steps - 1, max(0, round(steps * (1.0 - float(strength))))))
            sigmas = sigmas[first:]
            self._vae = None                    # the decoder is recompiled later; never hold both VAEs
            gc.collect()
            x = self.encode_image(init_image) + noise * sigmas[0]
            gc.collect()
        self._unet_model()
        total_evals = (len(sigmas) - 1) * 2

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
        if release_unet:
            self._unet = None
            gc.collect()
        t2 = time.perf_counter()
        img = self.decode(x)
        st.vae_s = time.perf_counter() - t2
        st.load_s = self.load_s - load0
        return img, st
