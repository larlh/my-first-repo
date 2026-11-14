"""Person matting: image -> alpha matte.

    from parlante_engine.matting.api import matte
    alpha = matte(image_bgr)        # uint8 HxWx3 (OpenCV BGR) -> float32 HxW in 0..1

Stable interface used by `prepare` (portrait matte) and by the stock-library tooling. The
model behind it is declared in models.py; `matte` loads it lazily, keeps it for a short while
and releases it when idle so the animator has the memory.
"""
from __future__ import annotations

import threading
import time

import cv2
import numpy as np

from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import EngineError
from parlante_engine.core.registry import get_registry

from .models import ORMBG

INPUT_SIDE = 1024
IDLE_RELEASE_SECONDS = 120.0

_lock = threading.Lock()
_model = None
_last_used = 0.0
_timer: threading.Timer | None = None


class OrmbgMatter:
    """ORMBG (IS-Net) ONNX graph executed with OpenVINO (ONNX Runtime when OpenVINO is not
    available). Fixed 1024x1024 RGB input scaled to 0..1; the output is already a 0..1 matte.
    Measured on 4 cores: ~0.4 s per image, ~0.7 GB peak RSS."""

    def __init__(self, path, threads: int | None = None):
        from parlante_engine.core import backends

        threads = threads or get_settings().threads
        self.backend = backends.heavy_backend()
        if self.backend == "openvino":
            import openvino as ov

            core = ov.Core()
            cfg = {"INFERENCE_NUM_THREADS": threads, "PERFORMANCE_HINT": "LATENCY"}
            self._net = core.compile_model(core.read_model(str(path)), "CPU", cfg)
            self._port = self._net.inputs[0]
            self._run = lambda x: np.array(self._net({self._port: x})[0])
        else:
            sess = backends.ort_session(path, threads, allow_gpu=True)
            name = sess.get_inputs()[0].name
            self._run = lambda x: sess.run(None, {name: x})[0]

    def alpha(self, bgr: np.ndarray) -> np.ndarray:
        h, w = bgr.shape[:2]
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        interp = cv2.INTER_AREA if max(h, w) > INPUT_SIDE else cv2.INTER_LINEAR
        x = cv2.resize(rgb, (INPUT_SIDE, INPUT_SIDE), interpolation=interp).astype(np.float32) / 255.0
        a = self._run(np.ascontiguousarray(x.transpose(2, 0, 1)[None], np.float32))[0, 0]
        interp = cv2.INTER_AREA if max(h, w) < INPUT_SIDE else cv2.INTER_LINEAR
        return np.clip(cv2.resize(a.astype(np.float32), (w, h), interpolation=interp), 0.0, 1.0)


def available() -> bool:
    """True when the matting weights are downloaded (checksums verified)."""
    return get_registry().locate(ORMBG) is not None


def _release_if_idle() -> None:
    global _model, _timer
    with _lock:
        if _model is not None and time.monotonic() - _last_used >= IDLE_RELEASE_SECONDS - 1:
            _model = None
        _timer = None


def release() -> None:
    """Drop the loaded model now (frees ~0.5 GB)."""
    global _model
    with _lock:
        _model = None


def matte(image: np.ndarray) -> np.ndarray:
    """Alpha matte of the person: float32 HxW in 0..1 (1 = person), same size as `image`.

    `image`: uint8 HxWx3 in OpenCV BGR order (HxWx4 BGRA is accepted; alpha is ignored).
    Raises EngineError(SERVICE_UNAVAILABLE) when the matting weights are not downloaded."""
    global _model, _last_used, _timer
    if not isinstance(image, np.ndarray) or image.ndim != 3 or image.shape[2] not in (3, 4) or image.dtype != np.uint8:
        raise EngineError("VALIDATION_ERROR", "matte() expects a uint8 HxWx3 BGR image.", "invalid_image")
    bgr = np.ascontiguousarray(image[..., :3])
    with _lock:
        if _model is None:
            _model = OrmbgMatter(get_registry().require(ORMBG))
        alpha = _model.alpha(bgr)
        _last_used = time.monotonic()
        if _timer is None:
            _timer = threading.Timer(IDLE_RELEASE_SECONDS, _release_if_idle)
            _timer.daemon = True
            _timer.start()
    return alpha


def refine_edges(alpha: np.ndarray) -> np.ndarray:
    """Remove faint background haze and small isolated specks from a matte without touching
    the soft hair edge: values below 2 % go to 0, and opaque blobs that are tiny (< 2 % of the
    main region) and detached from it are erased. Large regions are never removed."""
    a = np.where(alpha < 0.02, 0.0, alpha).astype(np.float32)
    binary = (a > 0.5).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if n > 2:
        areas = stats[1:, cv2.CC_STAT_AREA]
        main = 1 + int(np.argmax(areas))
        near_main = cv2.dilate((labels == main).astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
        for label in range(1, n):
            if label == main or areas[label - 1] >= 0.02 * areas[main - 1]:
                continue
            blob = labels == label
            if (blob & near_main).any():
                continue
            a[cv2.dilate(blob.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0] = 0.0
    return a
