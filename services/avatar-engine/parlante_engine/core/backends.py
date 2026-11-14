"""Inference backends and thread limits.

CPU: OpenVINO for the convolutional graphs (bf16 on CPUs with AMX / AVX512-BF16, f32
otherwise — chosen by OpenVINO itself with precision "auto") and ONNX Runtime for everything
OpenVINO cannot load (5-D GridSample) and for the small graphs.
GPU: ONNX Runtime with the CUDA execution provider when `onnxruntime-gpu` is installed and a
CUDA device answers. IMPLEMENTED BUT NOT VERIFIED on the build machine (it has no GPU).
"""
from __future__ import annotations

import logging
import os
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .config import get_settings

log = logging.getLogger("parlante.backends")
_ov_lock = threading.Lock()
_ov_core = None


def limit_threads() -> None:
    """Cap the thread pools of the numeric libraries before they start (call once, early)."""
    n = str(get_settings().threads)
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(var, n)
    try:
        import cv2
        cv2.setNumThreads(min(get_settings().threads, 4))
    except Exception:  # noqa: BLE001
        pass


@lru_cache(maxsize=1)
def cuda_available() -> bool:
    if get_settings().device == "cpu":
        return False
    return "CUDAExecutionProvider" in ort.get_available_providers()


@lru_cache(maxsize=1)
def openvino_available() -> bool:
    try:
        import openvino  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def device() -> str:
    """'gpu' or 'cpu' as reported by /health."""
    return "gpu" if cuda_available() else "cpu"


def heavy_backend() -> str:
    """Backend for the heavy graphs: 'cuda' | 'openvino' | 'onnxruntime'."""
    s = get_settings()
    if cuda_available() and s.backend != "openvino":
        return "cuda"
    if s.backend in ("auto", "openvino") and openvino_available():
        return "openvino"
    return "onnxruntime"


def ort_providers(allow_gpu: bool = True) -> list[str]:
    return (["CUDAExecutionProvider"] if allow_gpu and cuda_available() else []) + ["CPUExecutionProvider"]


def ort_session(path: str | Path, threads: int | None = None, allow_gpu: bool = False) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads or get_settings().threads
    so.inter_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 3
    return ort.InferenceSession(str(path), so, providers=ort_providers(allow_gpu))


class OrtModel:
    """Callable wrapper: feed dict -> list of outputs."""

    def __init__(self, path: str | Path, threads: int | None = None, allow_gpu: bool = True):
        self.sess = ort_session(path, threads, allow_gpu)
        self.input_names = [i.name for i in self.sess.get_inputs()]
        self.backend = "onnxruntime:" + self.sess.get_providers()[0]

    def __call__(self, feed: dict) -> list[np.ndarray]:
        return self.sess.run(None, feed)


def _core():
    global _ov_core
    with _ov_lock:
        if _ov_core is None:
            import openvino as ov
            _ov_core = ov.Core()
        return _ov_core


class OvModel:
    """OpenVINO CPU model. `precision`: 'auto' (bf16 where the CPU has it), 'f32' or 'bf16'."""

    def __init__(self, path: str | Path, threads: int | None = None, precision: str | None = None,
                 static_shapes: dict | None = None):
        core = _core()
        model = core.read_model(str(path))
        if static_shapes:
            model.reshape(static_shapes)
        cfg: dict = {"INFERENCE_NUM_THREADS": threads or get_settings().threads, "PERFORMANCE_HINT": "LATENCY"}
        precision = precision or get_settings().precision
        if precision in ("f32", "bf16"):
            cfg["INFERENCE_PRECISION_HINT"] = precision
        self.cm = core.compile_model(model, "CPU", cfg)
        self.req = self.cm.create_infer_request()
        self.inputs = list(self.cm.inputs)
        self.outputs = list(self.cm.outputs)
        try:
            self.precision = str(self.cm.get_property("INFERENCE_PRECISION_HINT"))
        except Exception:  # noqa: BLE001
            self.precision = "unknown"
        self.backend = "openvino:CPU:" + self.precision

    def input_name(self, port) -> set[str]:
        return set(port.get_names())

    def infer(self, feed: dict) -> dict:
        """feed keyed by port -> results keyed by port (arrays are views: copy to keep)."""
        return self.req.infer(feed)

    def __call__(self, feed: dict) -> list[np.ndarray]:
        by_port = {}
        for port in self.inputs:
            name = next(n for n in port.get_names() if n in feed)
            by_port[port] = feed[name]
        res = self.req.infer(by_port)
        return [np.array(res[o]) for o in self.outputs]


def release_memory() -> None:
    """After dropping a large model: collect garbage and hand freed heap pages back to the OS."""
    import gc

    gc.collect()
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001 - not glibc: nothing to do
        pass


def describe() -> dict:
    return {
        "device": device(),
        "heavyBackend": heavy_backend(),
        "onnxruntime": ort.__version__,
        "onnxruntimeProviders": ort.get_available_providers(),
        "openvino": openvino_available(),
        "gpuVerified": False,
    }
