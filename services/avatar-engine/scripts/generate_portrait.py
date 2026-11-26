#!/usr/bin/env python3
"""Generate one synthetic presenter portrait from the command line (same code path as
POST /v1/portraits/generate, without the HTTP server).

    python scripts/generate_portrait.py --out out/ana --description "mujer de 35 años, pelo castaño" --seed 7
    python scripts/generate_portrait.py --out out/leo --gender male --age 52 --skin-tone dark \
        --hair "short graying hair" --style business --seed 11 --size 768

Writes <out>/portrait.png and <out>/portrait.json (prompt, seeds, quality-control report, timings).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parlante_engine.core import backends  # noqa: E402
from parlante_engine.core.errors import EngineError  # noqa: E402
from parlante_engine.portrait.prompts import BACKGROUNDS, SKIN_TONES, STYLES, PortraitSpec  # noqa: E402
from parlante_engine.portrait.service import GenerateJob, run_generate  # noqa: E402


class _Progress:
    """Minimal stand-in for the job context: prints progress lines."""

    def __init__(self) -> None:
        self._last = 0.0

    def progress(self, fraction: float, eta_sec: float | None = None) -> None:
        if time.monotonic() - self._last > 5 or fraction >= 0.99:
            self._last = time.monotonic()
            eta = "" if eta_sec is None else f"  eta {eta_sec:5.0f} s"
            print(f"  {fraction * 100:5.1f} %{eta}", flush=True)

    def check_canceled(self) -> None:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--size", type=int, default=768, help="square side in pixels (384..768)")
    ap.add_argument("--description", help="free text (Spanish or English); otherwise the structured options")
    ap.add_argument("--gender", choices=["female", "male", "neutral"])
    ap.add_argument("--age", type=int)
    ap.add_argument("--skin-tone", choices=sorted(SKIN_TONES))
    ap.add_argument("--heritage")
    ap.add_argument("--hair")
    ap.add_argument("--clothing")
    ap.add_argument("--extra")
    ap.add_argument("--style", choices=sorted(STYLES), default="business")
    ap.add_argument("--background", choices=sorted(BACKGROUNDS), default="light-gray")
    ap.add_argument("--steps", type=int)
    ap.add_argument("--guidance", type=float)
    ap.add_argument("--attempts", type=int)
    ap.add_argument("--name", default="portrait", help="file stem")
    args = ap.parse_args()
    backends.limit_threads()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    spec = None
    if not args.description:
        spec = PortraitSpec(gender=args.gender or "neutral", age=args.age, skin_tone=args.skin_tone,
                            heritage=args.heritage, hair=args.hair, clothing=args.clothing, style=args.style,
                            extra=args.extra, background=args.background)
    job = GenerateJob(output_dir=out, seed=args.seed, width=args.size, height=args.size, description=args.description,
                      gender=args.gender, spec=spec, steps=args.steps, guidance=args.guidance,
                      max_attempts=args.attempts, file_stem=args.name)
    try:
        result = run_generate(job, _Progress())
    except EngineError as exc:
        print(f"ERROR [{exc.code}] {exc.message}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
