#!/usr/bin/env python3
"""Objective audio-to-lips measurements on a rendered clip, shared by `eval_clip.py` and
`compare_drivers.py`. Nobody listens or watches here: everything is measured on the pixels of
the encoded clip (FaceMesh landmarks) and on the samples of the WAV.

  lip opening   inner-lip gap / mouth width (`face_metrics()["lip_ratio"]`) per frame
  loudness      RMS envelope of the speech, 25 ms window, 10 ms hop
  lag           shift (ms, 10 ms steps) that maximises the correlation between the two;
                positive = the lips move AFTER the sound
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

SR = 16000
GRID_HZ = 100


def read_frames(path: str | Path, gray: bool = False) -> tuple[np.ndarray, float]:
    info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                      "stream=width,height,r_frame_rate", "-of", "json", str(path)],
                                     capture_output=True, text=True, check=True).stdout)["streams"][0]
    num, den = info["r_frame_rate"].split("/")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt",
                          "gray" if gray else "rgb24", "-"], capture_output=True, check=True).stdout
    shape = (-1, info["height"], info["width"]) if gray else (-1, info["height"], info["width"], 3)
    return np.frombuffer(raw, np.uint8).reshape(shape), float(num) / float(den)


def corr(a: np.ndarray, b: np.ndarray) -> float | None:
    if len(a) < 3 or a.std() < 1e-9 or b.std() < 1e-9:
        return None
    return round(float(np.corrcoef(a, b)[0, 1]), 3)


def loudness_envelope(wav: np.ndarray, n: int, hz: int = GRID_HZ, window_ms: float = 25.0) -> np.ndarray:
    """RMS of `wav` (float32 mono 16 kHz) around each of `n` instants spaced 1/hz s apart."""
    half = int(SR * window_ms / 2000.0)
    env = np.zeros(n)
    for i in range(n):
        c = int((i + 0.5) * SR / hz)
        seg = wav[max(0, c - half):c + half]
        env[i] = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
    return env


def frame_envelope(wav: np.ndarray, n_frames: int, fps: float) -> np.ndarray:
    hop = SR / fps
    return np.array([float(np.sqrt(np.mean(wav[int(i * hop):int((i + 1) * hop)] ** 2) + 1e-12))
                     if int(i * hop) < len(wav) else 0.0 for i in range(n_frames)])


def to_grid(track: np.ndarray, fps: float, hz: int = GRID_HZ) -> np.ndarray:
    """Per-frame track (sampled at frame centres) -> the 100 Hz grid of the loudness envelope."""
    n = int(round(len(track) / fps * hz))
    return np.interp((np.arange(n) + 0.5) / hz, (np.arange(len(track)) + 0.5) / fps, track)


def best_lag_ms(lips: np.ndarray, sound: np.ndarray, max_ms: float = 200.0, hz: int = GRID_HZ) -> tuple[float, float | None]:
    """Lag of `lips` behind `sound` (both on the same grid) with the highest correlation."""
    n = min(len(lips), len(sound))
    lips, sound = lips[:n], sound[:n]
    best: tuple[float, float | None] = (0.0, None)
    steps = int(max_ms / 1000.0 * hz)
    for lag in range(-steps, steps + 1):
        a, b = (lips[lag:], sound[:n - lag]) if lag >= 0 else (lips[:n + lag], sound[-lag:])
        c = corr(a, b)
        if c is not None and (best[1] is None or c > best[1]):
            best = (lag * 1000.0 / hz, c)
    return best


def silent_frames(env_frames: np.ndarray, guard: int = 2, floor_db: float = -40.0) -> np.ndarray:
    """Frames that are inside a pause and at least `guard` frames away from speech."""
    quiet = 20 * np.log10(env_frames / (env_frames.max() + 1e-12) + 1e-9) < floor_db
    out = quiet.copy()
    for k in range(1, guard + 1):
        out[k:] &= quiet[:-k]
        out[:-k] &= quiet[k:]
    return out


def measure_tracks(frames: np.ndarray) -> dict:
    """FaceMesh on every frame -> per-frame arrays (lip, width, eye, nose, landmarks) + misses."""
    from parlante_engine.prepare.face import face_metrics, get_face_landmarker

    mesh = get_face_landmarker()
    lips, widths, eyes, noses, lms, missing = [], [], [], [], [], 0
    last = None
    for f in frames:
        lm = mesh.landmarks(f)
        if lm is None:
            missing += 1
            lm = last
        if lm is None:
            lips.append(0.0), widths.append(0.0), eyes.append(0.3), noses.append((0.0, 0.0)), lms.append(None)
            continue
        last = lm
        m = face_metrics(lm)
        lips.append(m["lip_ratio"]), widths.append(m["mouth_width"])
        eyes.append(0.5 * (m["eye_l"] + m["eye_r"]))
        noses.append((float(lm[1, 0]), float(lm[1, 1])))
        lms.append(lm)
    return {"lip": np.array(lips), "width": np.array(widths), "eye": np.array(eyes), "nose": np.array(noses),
            "landmarks": lms, "missing": missing}


def audio_lip_metrics(lip: np.ndarray, wav: np.ndarray, fps: float, cues: list[dict] | None = None,
                      duration_ms: float | None = None) -> dict:
    n = len(lip)
    env_f = frame_envelope(wav, n, fps)
    grid_lip = to_grid(lip, fps)
    env_g = loudness_envelope(wav, len(grid_lip))
    lag, c_best = best_lag_ms(grid_lip, env_g)
    sil = silent_frames(env_f)
    speech = env_f > 0.05 * env_f.max()
    res = {
        "corrOpenVsLoudness": corr(lip, env_f),
        "lagMs": lag, "corrAtBestLag": c_best,
        "lipInSilenceMean": round(float(lip[sil].mean()), 4) if sil.any() else None,
        "lipInSilenceMax": round(float(lip[sil].max()), 4) if sil.any() else None,
        "lipInSilenceStd": round(float(lip[sil].std()), 4) if sil.any() else None,
        "lipInSpeechMean": round(float(lip[speech].mean()), 4) if speech.any() else None,
        "lipMax": round(float(lip.max()), 4),
        "lipMaxStepPerFrame": round(float(np.abs(np.diff(lip)).max()), 4) if n > 1 else 0.0,
        "silentFrames": int(sil.sum()),
    }
    if cues:
        dur = duration_ms or n * 1000.0 / fps
        ends = [c["tMs"] for c in cues[1:]] + [dur]
        at = []
        for c, e in zip(cues, ends):
            if c["viseme"] != "MBP":
                continue
            f = int(round(0.5 * (c["tMs"] + e) / 1000.0 * fps - 0.5))
            if 0 <= f < n:
                at.append(float(lip[max(0, f - 1):f + 2].min()))       # the closure may land a frame either side
        res["bilabials"] = len(at)
        res["lipAtBilabialsMean"] = round(float(np.mean(at)), 4) if at else None
        res["lipAtBilabialsMax"] = round(float(np.max(at)), 4) if at else None
    return res


def _similarity(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares 2x3 similarity transform src -> dst (both [k,2])."""
    import cv2

    m, _ = cv2.estimateAffinePartial2D(src.astype(np.float32), dst.astype(np.float32), method=cv2.LMEDS)
    return m if m is not None else np.array([[1, 0, 0], [0, 1, 0]], np.float32)


STABLE = [33, 133, 263, 362, 168, 6, 197, 195, 5, 4, 1]      # eye corners + nose bridge / tip


def stability_metrics(frames: np.ndarray, tracks: dict, portrait_rgb: np.ndarray, mask: np.ndarray | None) -> dict:
    """Identity, background, blink and head-motion figures of a clip against its portrait.

    identityPsnrDb   PSNR of the upper face (brows to nose base, between the outer eye corners) of
                     each frame, aligned on eye corners and nose bridge, against the same patch of
                     the portrait; median and worst frame. It is a pixel measure of "still the same
                     face", not a face-recognition score (no such model is shipped).
    faceShapeDriftPct  95th percentile of the change of two face proportions (eye distance / face
                     width, nose length / eye distance) against the portrait.
    backgroundMad    mean absolute difference (0..255) to the portrait over the pixels the matte
                     calls background, 8 px away from the person; and its worst frame.
    """
    import cv2

    from parlante_engine.prepare.face import get_face_landmarker

    h, w = frames.shape[1:3]
    ref = cv2.resize(portrait_rgb, (w, h), interpolation=cv2.INTER_AREA)
    lm_ref = get_face_landmarker().landmarks(ref)
    res: dict = {}
    eye = tracks["eye"]
    closed = eye < 0.55 * np.median(eye)
    res["blinks"] = int(np.sum(np.diff(closed.astype(int)) == 1) + (1 if closed[0] else 0))
    nose = tracks["nose"]
    if lm_ref is not None:
        eye_dist = float(np.linalg.norm(lm_ref[33, :2] - lm_ref[263, :2]))
        res["headTravelPctEyeDist"] = [round(float(np.ptp(nose[:, 0])) / eye_dist * 100, 1),
                                       round(float(np.ptp(nose[:, 1])) / eye_dist * 100, 1)]
        res["headJitterPctEyeDist"] = round(float(np.abs(np.diff(nose, n=2, axis=0)).mean()) / eye_dist * 100, 3)
        x0, x1 = int(lm_ref[33, 0]), int(lm_ref[263, 0])
        y0, y1 = int(min(lm_ref[105, 1], lm_ref[334, 1])), int(lm_ref[2, 1])
        patch_ref = ref[y0:y1, x0:x1].astype(np.float32)

        def proportions(lm: np.ndarray) -> np.ndarray:
            d = lambda a, b: float(np.linalg.norm(lm[a, :2] - lm[b, :2]))  # noqa: E731
            return np.array([d(33, 263) / (d(234, 454) + 1e-6), d(168, 2) / (d(33, 263) + 1e-6)])

        p_ref = proportions(lm_ref)
        psnr, drift = [], []
        for frame, lm in zip(frames, tracks["landmarks"]):
            if lm is None:
                continue
            m = _similarity(lm[STABLE, :2], lm_ref[STABLE, :2])
            aligned = cv2.warpAffine(frame, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            mse = float(np.mean((aligned[y0:y1, x0:x1].astype(np.float32) - patch_ref) ** 2))
            psnr.append(10 * np.log10(255.0 ** 2 / max(mse, 1e-6)))
            drift.append(np.abs(proportions(lm) - p_ref) / p_ref * 100)
        if psnr:
            res["identityPsnrDb"] = round(float(np.median(psnr)), 1)
            res["identityPsnrMinDb"] = round(float(np.min(psnr)), 1)
            res["faceShapeDriftPct"] = round(float(np.percentile(np.array(drift), 95)), 2)
    if mask is not None:
        m = cv2.resize(mask, (w, h), interpolation=cv2.INTER_AREA)
        bg = cv2.erode((m < 13).astype(np.uint8), np.ones((17, 17), np.uint8)) > 0
        if bg.any():
            diffs = np.array([float(np.abs(f[bg].astype(np.int16) - ref[bg].astype(np.int16)).mean()) for f in frames])
            res["backgroundMad"] = round(float(diffs.mean()), 3)
            res["backgroundMadWorstFrame"] = round(float(diffs.max()), 3)
    d = np.abs(np.diff(frames.astype(np.int16), axis=0))
    res["frameDiffMean"] = round(float(d.mean()), 3)
    return res
