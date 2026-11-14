"""The frame generator (LivePortrait warping + SPADE decoder): feature volume + source and
driving keypoints -> 512x512 RGB frame.

Backends
  hybrid  (CPU default)  The graph is split at its two 5-D GridSample nodes: the three
          convolutional stages run in OpenVINO (bf16 on AMX / AVX512-BF16 CPUs, f32 otherwise)
          and the two GridSample nodes stay in ONNX Runtime (OpenVINO's ONNX frontend rejects
          5-D GridSample). Measured on the build machine (4 vCPU Xeon, AMX): 0.95 s/frame and
          63.5 dB PSNR against the f32 reference, versus 4.6 s/frame for plain ONNX Runtime.
  ort     Original graph in ONNX Runtime: CPU fallback (no OpenVINO) and the CUDA path.
          The CUDA path is implemented but NOT verified (no GPU on the build machine).
The split graphs are derived files (data only), cached in <models_dir>/derived/.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import threading
import time
from pathlib import Path

import numpy as np

from parlante_engine.core import backends
from parlante_engine.core.config import get_settings
from parlante_engine.core.registry import get_registry

from .models import WARPING_SPADE

log = logging.getLogger("parlante.generator")
SPLIT_VERSION = 1
_split_lock = threading.Lock()


def split_dir() -> Path:
    return get_settings().models_dir / "derived" / f"warping_spade-split-v{SPLIT_VERSION}-{WARPING_SPADE.sha256[:12]}"


def split_ready() -> bool:
    return (split_dir() / "plan.json").is_file()


def build_split(log_fn=log.info) -> Path:
    """Split warping_spade.onnx into stageA/B/C (conv only) + gs1/gs2 (single GridSample)."""
    out = split_dir()
    with _split_lock:
        if split_ready():
            return out
        import onnx
        import onnx.utils
        from onnx import helper, shape_inference

        src = get_registry().require(WARPING_SPADE)
        t0 = time.time()
        log_fn("deriving the split generator graphs (one-off, about a minute)…")
        tmp_dir = out.with_name(out.name + ".tmp")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        tmp_dir.mkdir(parents=True)
        model = shape_inference.infer_shapes(onnx.load(str(src)))
        g = model.graph
        gs = [n for n in g.node if n.op_type == "GridSample"]
        if len(gs) != 2:
            raise RuntimeError(f"expected 2 GridSample nodes, found {len(gs)}")
        gs1, gs2 = gs
        producer = {o: n for n in g.node for o in n.output}
        inits = {i.name for i in g.initializer}
        graph_inputs = [i.name for i in g.input if i.name not in inits]

        def depends_on(node, tensor, memo):
            key = node.name
            if key in memo:
                return memo[key]
            memo[key] = False
            hit = False
            for i in node.input:
                if i == tensor or (i in producer and depends_on(producer[i], tensor, memo)):
                    hit = True
                    break
            memo[key] = hit
            return hit

        old_limit = sys.getrecursionlimit()
        sys.setrecursionlimit(20000)
        try:
            m1: dict = {}
            m2: dict = {}
            stage = {}
            for n in g.node:
                if n is gs1 or n is gs2:
                    continue
                if depends_on(n, gs2.output[0], m2):
                    stage[n.name] = "C"
                elif depends_on(n, gs1.output[0], m1):
                    stage[n.name] = "B"
                else:
                    stage[n.name] = "A"
        finally:
            sys.setrecursionlimit(old_limit)

        def crossing(frm, to_nodes):
            need = []
            for n in to_nodes:
                for i in n.input:
                    if i in inits or i in need or i in graph_inputs:
                        continue
                    p = producer.get(i)
                    if p is None or p is gs1 or p is gs2:
                        continue
                    if stage.get(p.name) in frm:
                        need.append(i)
            return need

        nodes_b = [n for n in g.node if stage.get(n.name) == "B"]
        nodes_c = [n for n in g.node if stage.get(n.name) == "C"]
        a_out = list(dict.fromkeys(list(gs1.input) + crossing({"A"}, nodes_b + nodes_c + [gs2])))
        a_out = [t for t in a_out if t not in graph_inputs and t not in inits]
        b_out = list(dict.fromkeys([i for i in gs2.input if i not in graph_inputs] + crossing({"B"}, nodes_c)))

        def used_inputs(nodes):
            return [i for i in graph_inputs if any(i in n.input for n in nodes)]

        a_in = graph_inputs
        b_in = [gs1.output[0]] + crossing({"A"}, nodes_b) + used_inputs(nodes_b)
        c_in = [gs2.output[0]] + crossing({"A"}, nodes_c) + crossing({"B"}, nodes_c) + used_inputs(nodes_c)
        shaped = tmp_dir / "_shaped.onnx"
        onnx.save(model, str(shaped))
        onnx.utils.extract_model(str(shaped), str(tmp_dir / "stageA.onnx"), a_in, a_out)
        onnx.utils.extract_model(str(shaped), str(tmp_dir / "stageB.onnx"), b_in, b_out)
        onnx.utils.extract_model(str(shaped), str(tmp_dir / "stageC.onnx"), c_in, [o.name for o in g.output])
        vi = {v.name: v for v in list(g.value_info) + list(g.input) + list(g.output)}
        for key, node in (("gs1", gs1), ("gs2", gs2)):
            sub = helper.make_model(helper.make_graph([node], key, [vi[i] for i in node.input],
                                                      [vi[o] for o in node.output]),
                                    opset_imports=model.opset_import)
            sub.ir_version = model.ir_version
            onnx.save(sub, str(tmp_dir / f"{key}.onnx"))
        shaped.unlink()
        plan = {"A_in": a_in, "A_out": a_out, "B_in": b_in, "B_out": b_out, "C_in": c_in,
                "gs1_in": list(gs1.input), "gs1_out": gs1.output[0], "gs2_in": list(gs2.input),
                "gs2_out": gs2.output[0], "final": [o.name for o in g.output], "source_sha256": WARPING_SPADE.sha256}
        (tmp_dir / "plan.json").write_text(json.dumps(plan, indent=1))
        shutil.rmtree(out, ignore_errors=True)
        os.replace(tmp_dir, out)
        log_fn(f"split graphs ready in {time.time() - t0:.0f}s: {out}")
        return out


class _HybridGenerator:
    def __init__(self, threads: int):
        d = build_split()
        self.plan = json.loads((d / "plan.json").read_text())
        self.stages = {}
        for s in "ABC":
            model = backends.OvModel(d / f"stage{s}.onnx", threads)
            want_in = self.plan[f"{s}_in"]
            want_out = self.plan[f"{s}_out"] if s != "C" else self.plan["final"]
            ins = [next(n for n in want_in if n in port.get_names()) for port in model.inputs]
            outs = [next(n for n in want_out if n in port.get_names()) for port in model.outputs]
            self.stages[s] = (model, ins, outs)
        self.gs1 = backends.ort_session(d / "gs1.onnx", threads)
        self.gs2 = backends.ort_session(d / "gs2.onnx", threads)
        self.backend = "hybrid(" + self.stages["B"][0].backend + "+onnxruntime:GridSample)"
        self.last_times: dict = {}

    def _stage(self, s: str, env: dict) -> None:
        model, ins, outs = self.stages[s]
        res = model.infer({port: env[n] for port, n in zip(model.inputs, ins)})
        for port, n in zip(model.outputs, outs):
            env[n] = res[port].copy()

    def __call__(self, feature_3d: np.ndarray, kp_driving: np.ndarray, kp_source: np.ndarray) -> np.ndarray:
        p = self.plan
        env = {"feature_3d": feature_3d, "kp_driving": kp_driving, "kp_source": kp_source}
        self._stage("A", env)
        env[p["gs1_out"]] = self.gs1.run(None, {n: np.asarray(env[n]) for n in p["gs1_in"]})[0]
        self._stage("B", env)
        env[p["gs2_out"]] = self.gs2.run(None, {n: np.asarray(env[n]) for n in p["gs2_in"]})[0]
        self._stage("C", env)
        return np.asarray(env[p["final"][0]])


class _OrtGenerator:
    def __init__(self, threads: int):
        self.model = backends.OrtModel(get_registry().require(WARPING_SPADE), threads, allow_gpu=True)
        self.backend = self.model.backend

    def __call__(self, feature_3d, kp_driving, kp_source) -> np.ndarray:
        return self.model({"feature_3d": feature_3d, "kp_driving": kp_driving, "kp_source": kp_source})[0]


class Generator:
    """feature_3d [1,32,16,64,64], kp_driving [1,21,3], kp_source [1,21,3] -> RGB uint8 [512,512,3]."""

    def __init__(self, threads: int | None = None, backend: str | None = None):
        threads = threads or get_settings().threads
        backend = backend or backends.heavy_backend()
        self._impl = _HybridGenerator(threads) if backend == "openvino" else _OrtGenerator(threads)
        self.backend = self._impl.backend

    def raw(self, feature_3d: np.ndarray, kp_driving: np.ndarray, kp_source: np.ndarray) -> np.ndarray:
        """Float output [1,3,512,512] in 0..1 (used by fidelity tests)."""
        return self._impl(feature_3d, kp_driving.astype(np.float32), kp_source.astype(np.float32))

    def __call__(self, feature_3d: np.ndarray, kp_driving: np.ndarray, kp_source: np.ndarray) -> np.ndarray:
        out = self.raw(feature_3d, kp_driving, kp_source)[0]
        return (np.clip(out.transpose(1, 2, 0), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
