#!/usr/bin/env python3
"""Command-line use of the engine without the HTTP server: photo (or prepared portrait) + WAV
(+ Parlante SceneRuntime JSON with the viseme timeline) -> clip + matte clip + stats JSON.

    python scripts/render_clip.py --image photo.jpg --audio speech.wav --runtime runtime.json --out out_dir
    python scripts/render_clip.py --portrait portrait.png --mask mask.png --audio speech.wav --out out_dir

Without --runtime the audio-driven model is used. With --mux a review copy with sound is written.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parlante_engine.core import backends  # noqa: E402
from parlante_engine.core.errors import EngineError  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", help="raw photo: runs `prepare` first")
    ap.add_argument("--portrait", help="already prepared portrait (PNG)")
    ap.add_argument("--mask", help="matte of the prepared portrait")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--runtime", help="JSON with {visemes:[{tMs,viseme}], words?:[...]}")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--max-size", type=int, default=512)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--driver", default="auto", choices=["auto", "visemes", "audio"])
    ap.add_argument("--max-frames", type=int)
    ap.add_argument("--mux", action="store_true", help="also write review.mp4 (clip + audio)")
    a = ap.parse_args()
    backends.limit_threads()
    from parlante_engine.animate.service import AnimateJob, run_animation
    from parlante_engine.prepare.service import PrepareJob, run_prepare

    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    try:
        if a.image:
            prep = run_prepare(PrepareJob(Path(a.image).resolve(), out))
            portrait, mask = Path(prep["portraitPath"]), Path(prep["maskPath"]) if prep["maskPath"] else None
        elif a.portrait:
            prep = None
            portrait, mask = Path(a.portrait).resolve(), Path(a.mask).resolve() if a.mask else None
        else:
            ap.error("give --image or --portrait")
        runtime = json.loads(Path(a.runtime).read_text()) if a.runtime else {}
        res = run_animation(AnimateJob(portrait, mask, Path(a.audio).resolve(), out, fps=a.fps, max_size=a.max_size,
                                       visemes=runtime.get("visemes"), words=runtime.get("words"), driver=a.driver,
                                       seed=a.seed, max_frames=a.max_frames))
    except EngineError as exc:
        print(json.dumps({"error": exc.to_dict()}, indent=1))
        return 1
    if a.mux:
        review = out / "review.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", res["videoPath"], "-i", str(Path(a.audio).resolve()),
                        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest",
                        "-movflags", "+faststart", str(review)], check=True)
        res["reviewPath"] = str(review)
    (out / "result.json").write_text(json.dumps({"prepare": prep, "animate": res}, indent=1))
    print(json.dumps({"prepare": prep, "animate": res}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
