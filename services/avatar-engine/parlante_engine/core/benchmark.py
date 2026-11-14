"""Generator benchmark: measures seconds per frame on THIS machine with synthetic tensors of
the real shapes (the cost of the generator does not depend on the picture). Used at startup
when no measurement exists yet, and by scripts/benchmark.py."""
from __future__ import annotations

import os
import time

import numpy as np

from . import perf
from .jobs import JobContext


def run_benchmark(ctx: JobContext | None = None, frames: int = 6) -> dict:
    from parlante_engine.animate.lp import get_engine

    t0 = time.monotonic()
    engine = get_engine()
    load_s = time.monotonic() - t0
    rng = np.random.default_rng(0)
    f_s = (rng.standard_normal((1, 32, 16, 64, 64)) * 0.3).astype(np.float32)
    x_s = (rng.random((1, 21, 3)) - 0.5).astype(np.float32)
    engine.generator.raw(f_s, x_s + 0.01, x_s)            # warm-up (first call allocates)
    times = []
    for i in range(frames):
        if ctx:
            ctx.check_canceled()
            ctx.progress(i / frames, None)
        t = time.monotonic()
        engine.generator.raw(f_s, x_s + 0.01 * (i + 1), x_s)
        times.append(time.monotonic() - t)
    spf = float(np.median(times)) + 0.03                   # + measured paste / matte / encode overhead
    entry = perf.record("visemes", spf, frames, {"source": "benchmark", "backend": engine.generator.backend,
                                                 "setupSeconds": round(load_s, 2)})
    return {"kind": "benchmark", "secondsPerFrame": round(spf, 3), "frameTimes": [round(t, 3) for t in times],
            "loadSeconds": round(load_s, 2), "loadAvg1": round(os.getloadavg()[0], 2),
            "backend": engine.generator.backend, "stored": entry}
