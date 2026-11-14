#!/usr/bin/env python3
"""Measure the generator on this machine (seconds per frame) and store the result, so that
GET /health and job ETAs are honest. Run it while the machine is otherwise idle.

    python scripts/benchmark.py [--frames 12]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parlante_engine.core import backends  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--frames", type=int, default=12)
    a = ap.parse_args()
    backends.limit_threads()
    from parlante_engine.core.benchmark import run_benchmark

    res = run_benchmark(frames=a.frames)
    spf = res["secondsPerFrame"]
    res["minutesPer10sVideoAt30fps"] = round(spf * 300 / 60, 2)
    res["minutesPer10sVideoAt25fps"] = round(spf * 250 / 60, 2)
    print(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
