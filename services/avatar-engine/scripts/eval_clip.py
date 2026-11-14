#!/usr/bin/env python3
"""Objective checks on a rendered clip: commanded vs measured mouth opening (landmarks on the
rendered pixels), bilabial closure, blink count, head travel, temporal stability.

    python scripts/eval_clip.py clip.mp4 [--runtime runtime.json --seed N] [--audio speech.wav]

With --runtime (viseme driver) the commanded tracks are rebuilt from the timeline + seed; with
--audio (audio driver) mouth opening is compared with the loudness envelope of the speech.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def read_frames(path: str) -> tuple[np.ndarray, float]:
    info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                      "stream=width,height,r_frame_rate", "-of", "json", path],
                                     capture_output=True, text=True, check=True).stdout)["streams"][0]
    num, den = info["r_frame_rate"].split("/")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, info["height"], info["width"], 3), float(num) / float(den)


def corr(a: np.ndarray, b: np.ndarray) -> float | None:
    if a.std() < 1e-9 or b.std() < 1e-9:
        return None
    return round(float(np.corrcoef(a, b)[0, 1]), 3)


def best_lag(measured: np.ndarray, cmd: np.ndarray, max_lag: int = 5) -> tuple[int, float | None]:
    best = (0, None)
    for lag in range(-max_lag, max_lag + 1):
        a, b = (measured[lag:], cmd[:len(cmd) - lag]) if lag >= 0 else (measured[:lag], cmd[-lag:])
        c = corr(a, b)
        if c is not None and (best[1] is None or c > best[1]):
            best = (lag, c)
    return best


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clip")
    ap.add_argument("--runtime")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--audio")
    ap.add_argument("--out")
    a = ap.parse_args()
    from parlante_engine.animate import controls as C
    from parlante_engine.core.video import decode_audio
    from parlante_engine.prepare.face import face_metrics, get_face_landmarker

    frames, fps = read_frames(a.clip)
    mesh = get_face_landmarker()
    rows, missing = [], 0
    for f in frames:
        lm = mesh.landmarks(f)
        if lm is None:
            missing += 1
            rows.append(rows[-1] if rows else {"lip_ratio": 0, "mouth_width": 0, "eye_l": 0.3, "nose": (0, 0)})
            continue
        m = face_metrics(lm)
        m["nose"] = (float(lm[1, 0]), float(lm[1, 1]))
        rows.append(m)
    n = len(rows)
    lip = np.array([r["lip_ratio"] for r in rows])
    width = np.array([r["mouth_width"] for r in rows])
    eye = np.array([r["eye_l"] for r in rows])
    nose = np.array([r["nose"] for r in rows])
    diff = np.abs(np.diff(frames.astype(np.float32), axis=0)).mean(axis=3)
    h = frames.shape[1]
    closed = eye < 0.5 * np.median(eye)
    res: dict = {
        "clip": a.clip, "frames": n, "fps": fps, "framesWithoutFace": missing,
        "lipRatioRange": [round(float(lip.min()), 3), round(float(lip.max()), 3)],
        "blinks": int(np.sum(np.diff(closed.astype(int)) == 1)),
        "noseTravelPx": [round(float(np.ptp(nose[:, 0])), 1), round(float(np.ptp(nose[:, 1])), 1)],
        "frameDiffMean": round(float(diff.mean()), 3),
        "frameDiffMaxFrame": round(float(diff.mean(axis=(1, 2)).max()), 3),
        "topStripDiffMean": round(float(diff[:, : h // 16].mean()), 3),
        # jitter: energy of the 2nd difference of the nose track (px) - smooth motion keeps it small
        "noseJitterPx": round(float(np.abs(np.diff(nose, n=2, axis=0)).mean()), 3),
    }
    if a.runtime:
        rt = json.loads(Path(a.runtime).read_text())
        dur = rt.get("audioDurationMs") or n * 1000.0 / fps
        ctl = C.build_controls(rt["visemes"], dur, fps, a.seed, rt.get("words"), n_frames=n)
        cmd_open, cmd_width = ctl["mouth"][:, 0], ctl["mouth"][:, 1]
        res["corrOpenCmdVsMeasured"] = corr(cmd_open, lip)
        res["corrWidthCmdVsMeasured"] = corr(cmd_width, width)
        res["bestLagFramesOpen"] = best_lag(lip, cmd_open)
        cues = C.normalize_cues(rt["visemes"], dur)
        ends = [c["tMs"] for c in cues[1:]] + [dur]
        at_mbp = [float(lip[int(np.clip(round(0.5 * (c["tMs"] + e) / 1000 * fps - 0.5), 0, n - 1))])
                  for c, e in zip(cues, ends) if c["viseme"] == "MBP"]
        at_a = [float(lip[int(np.clip(round(0.5 * (c["tMs"] + e) / 1000 * fps - 0.5), 0, n - 1))])
                for c, e in zip(cues, ends) if c["viseme"] == "A" and e - c["tMs"] >= 60]
        res["lipRatioAtBilabials"] = {"n": len(at_mbp), "mean": round(float(np.mean(at_mbp)), 3) if at_mbp else None,
                                      "max": round(float(np.max(at_mbp)), 3) if at_mbp else None}
        res["lipRatioAtOpenVowelA"] = {"n": len(at_a), "mean": round(float(np.mean(at_a)), 3) if at_a else None}
    if a.audio:
        wav = decode_audio(Path(a.audio), 16000)
        hop = 16000 / fps
        env = np.array([np.sqrt(np.mean(wav[int(i * hop):int((i + 1) * hop)] ** 2) + 1e-12)
                        if int(i * hop) < len(wav) else 0.0 for i in range(n)])
        res["corrLoudnessVsMeasuredOpen"] = corr(env, lip)
        res["bestLagFramesLoudness"] = best_lag(lip, env)
        silent = env < 0.05 * env.max()
        res["lipRatioInSilence"] = round(float(lip[silent].mean()), 3) if silent.any() else None
        res["lipRatioInSpeech"] = round(float(lip[~silent].mean()), 3) if (~silent).any() else None
    print(json.dumps(res, indent=1))
    if a.out:
        Path(a.out).write_text(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
