"""Person matte for prepared portraits.

`compute_alpha(bgr)` prefers the `parlante_engine.matting` sub-package (portrait team: a
dedicated matting model) and falls back to MediaPipe's selfie-multiclass segmenter executed
with LiteRT (no mediapipe wheel, no GL libraries). Both sit behind the same call:

    compute_alpha(image_bgr: np.ndarray uint8 HxWx3) -> np.ndarray float32 HxW in 0..1 | None
"""
from __future__ import annotations

import importlib
import logging
import threading

import cv2
import numpy as np

from parlante_engine.core.registry import get_registry

from .models import SELFIE_MULTICLASS

log = logging.getLogger("parlante.matte")
_lock = threading.Lock()
_fallback = None


class SelfieMatte:
    """MediaPipe selfie multiclass (256x256, 6 classes; class 0 = background)."""

    def __init__(self):
        from ai_edge_litert.interpreter import Interpreter

        self.interp = Interpreter(model_path=str(get_registry().require(SELFIE_MULTICLASS)), num_threads=2)
        self.interp.allocate_tensors()
        self.inp = self.interp.get_input_details()[0]
        self.out = self.interp.get_output_details()[0]

    def alpha(self, bgr: np.ndarray) -> np.ndarray:
        h, w = bgr.shape[:2]
        # mirror-pad so that the picture border is not an edge for the network (bodies that leave
        # the frame otherwise get eaten at the corners), then letterbox to a square
        p = int(0.12 * max(h, w))
        padded = cv2.copyMakeBorder(bgr, p, p, p, p, cv2.BORDER_REFLECT_101)
        ph, pw = padded.shape[:2]
        side = max(ph, pw)
        canvas = cv2.copyMakeBorder(padded, 0, side - ph, 0, side - pw, cv2.BORDER_REPLICATE)
        x = cv2.resize(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB), (256, 256), interpolation=cv2.INTER_AREA)
        self.interp.set_tensor(self.inp["index"], (x.astype(np.float32) / 255.0)[None])
        self.interp.invoke()
        scores = self.interp.get_tensor(self.out["index"])[0]            # [256,256,6]
        if scores.min() < 0 or scores.max() > 1.0001:                     # logits -> probabilities
            e = np.exp(scores - scores.max(-1, keepdims=True))
            scores = e / e.sum(-1, keepdims=True)
        a = 1.0 - scores[..., 0]
        a = cv2.resize(a, (side, side), interpolation=cv2.INTER_CUBIC)[p:p + h, p:p + w]
        # the 256-px mask is soft and slightly wide: tighten the edge and denoise
        a = np.clip((a - 0.5) * 1.6 + 0.5, 0, 1)
        k = max(3, int(round(side / 256)) | 1)
        return cv2.GaussianBlur(a, (k, k), 0).astype(np.float32)


def _external():
    """(compute_alpha, release) of the `matting` sub-package when it is installed, importable and
    its weights are downloaded; otherwise (None, None)."""
    try:
        mod = importlib.import_module("parlante_engine.matting")
        fn = getattr(mod, "compute_alpha", None)
        available = getattr(mod, "available", None)
        if fn is None or (callable(available) and not available()):
            return None, None
        return fn, getattr(mod, "release", None)
    except Exception as exc:  # noqa: BLE001 - absent or broken sub-package: degrade to the fallback
        if not isinstance(exc, ModuleNotFoundError):
            log.warning("matting sub-package unusable (%s); using the fallback segmenter", exc)
        return None, None


def matte_source() -> str:
    return "matting" if _external()[0] is not None else "mediapipe-selfie-multiclass"


def compute_alpha(bgr: np.ndarray) -> np.ndarray | None:
    """Alpha matte of the person (float32 0..1, same size), or None when no matting is usable."""
    global _fallback
    fn, release = _external()
    if fn is not None:
        try:
            a = fn(bgr)
            if a is not None:
                a = np.asarray(a, np.float32)
                if a.max() > 1.5:
                    a = a / 255.0
                if a.shape[:2] != bgr.shape[:2]:
                    a = cv2.resize(a, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_LINEAR)
                return np.clip(a.reshape(bgr.shape[:2]), 0, 1)
        except Exception as exc:  # noqa: BLE001 - never fail `prepare` because of the matte
            log.warning("matting sub-package failed (%s); using the fallback segmenter", exc)
        finally:
            if callable(release):
                try:
                    release()        # give the memory back before the animator needs it
                except Exception:  # noqa: BLE001
                    pass
    if get_registry().locate(SELFIE_MULTICLASS) is None:
        return None
    with _lock:
        if _fallback is None:
            _fallback = SelfieMatte()
        return _fallback.alpha(bgr)
