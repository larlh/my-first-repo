"""The two drivers. Both turn their input into per-frame DRIVING KEYPOINTS for the same
generator; everything after that (stitching, rendering, paste-back, matte, encoding) is shared.

  VisemeDriver  Parlante viseme timeline -> deterministic rig animation (default).
  AudioDriver   WAV -> HuBERT features -> LMDM motion diffusion (Ditto) -> expression and pose.
                For audio without a timeline (uploaded voice, external TTS). Loads ~1.7 GB of
                extra weights lazily and frees them before rendering starts.
"""
from __future__ import annotations

import math
import os

import numpy as np

from parlante_engine.core import backends
from parlante_engine.core.registry import get_registry

from . import controls as C
from .lp import Avatar, LivePortrait, bins_to_degrees, rotation_matrix, transform_keypoints
from .models import HUBERT, LMDM
from .rig import Rig

# implicit-keypoint groups of the motion space (21 keypoints x 3)
KP_EYE = [11, 13, 15, 16, 18]
KP_LIP = [6, 12, 14, 17, 19, 20]


def _gaze_compensation(exp: np.ndarray, d_yaw: float, d_pitch: float) -> None:
    """Keep the eyes on the camera while the head turns (in place, exp is [21,3])."""
    dx, dy = d_yaw * 0.26, d_pitch * 0.28
    if dx > 0:
        exp[11, 0] += dx * 0.0007
        exp[15, 0] += dx * 0.001
    else:
        exp[11, 0] += dx * 0.001
        exp[15, 0] += dx * 0.0007
    exp[11, 1] += dy * -0.001
    exp[15, 1] += dy * -0.001


class VisemeDriver:
    name = "visemes"

    def __init__(self, engine: LivePortrait, avatar: Avatar, cues: list[dict], duration_ms: float, fps: float,
                 seed: int, words: list[dict] | None = None, n_frames: int | None = None):
        self.engine, self.avatar = engine, avatar
        self.rig = Rig(avatar.calib)
        self.ctl = C.build_controls(cues, duration_ms, fps, seed, words, n_frames)
        self.n_frames = int(self.ctl["mouth"].shape[0])
        # full blink = the eye-retargeting MLP's "closed" delta (computed once per clip)
        self.eye_closed = engine.eye_delta(avatar.x_s, float(avatar.eye_ratio[0]), float(avatar.eye_ratio[1]), 0.0)
        self._lip_cache: dict[int, np.ndarray] = {}

    def _lip(self, open_: float) -> np.ndarray:
        ratio = self.rig.open_to_ratio(open_)
        key = int(round(ratio * 4000))
        hit = self._lip_cache.get(key)
        if hit is None:
            hit = self.engine.lip_delta(self.avatar.x_s, self.avatar.lip_ratio, key / 4000.0)
            self._lip_cache[key] = hit
        return hit

    def keypoints(self, f: int) -> np.ndarray:
        a, ctl = self.avatar, self.ctl
        o, w, r, te = (float(v) for v in ctl["mouth"][f])
        d_pitch, d_yaw, d_roll = float(ctl["pitch"][f]), float(ctl["yaw"][f]), float(ctl["roll"][f])
        exp = a.exp + self.rig.exp_delta(o, w, r, te, float(ctl["brow"][f]))
        _gaze_compensation(exp, d_yaw, d_pitch)
        t = a.t.copy()
        t[0] += float(ctl["tx"][f])
        t[1] += float(ctl["ty"][f])
        x_d = transform_keypoints(a.x_c, rotation_matrix(a.pitch + d_pitch, a.yaw + d_yaw, a.roll + d_roll),
                                  exp, a.scale, t)
        x_d = x_d + self._lip(o)
        blink = float(ctl["blink"][f])
        if blink > 1e-3:
            x_d = x_d + blink * self.eye_closed
        return x_d.astype(np.float32)


# ------------------------------------------------------------------------------------------
# audio driver
# ------------------------------------------------------------------------------------------
SR = 16000
MODEL_FPS = 25          # the motion model's native rate
SEQ = 80                # LMDM clip length (frames)
MOTION_DIM = 265        # scale-1 | pitch66 | yaw66 | roll66 | t3 | exp63
HUBERT_DIM = 1024


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max())
    return e / e.sum()


def _cosine_alphas_cumprod(n: int = 1000, s: float = 8e-3) -> np.ndarray:
    t = np.arange(n + 1, dtype=np.float64) / n + s
    a = np.cos(t / (1 + s) * np.pi / 2) ** 2
    a = a / a[0]
    betas = np.clip(1 - a[1:] / a[:-1], 0, 0.999)
    return np.cumprod(1 - betas)


def _heavy(path, static_shapes=None):
    if backends.heavy_backend() == "openvino":
        return backends.OvModel(path, static_shapes=static_shapes)
    return backends.OrtModel(path, allow_gpu=True)


def silence_curve(wav: np.ndarray, n: int, fps: float, thresh_db: float = -38.0, ramp: int = 3) -> np.ndarray:
    """Per-frame lip-closure weight from audio energy: 1 inside pauses, soft ramps."""
    hop = SR / fps
    rms = np.zeros(n)
    for i in range(n):
        seg = wav[int(i * hop):int((i + 1) * hop)]
        rms[i] = math.sqrt(float(np.mean(seg ** 2)) + 1e-12) if len(seg) else 0.0
    db = 20 * np.log10(rms / (rms.max() + 1e-12) + 1e-6)
    sil = db < thresh_db
    min_frames = max(3, int(round(0.12 * fps)))
    keep = np.zeros(n, bool)
    i = 0
    while i < n:
        if sil[i]:
            j = i
            while j < n and sil[j]:
                j += 1
            if j - i >= min_frames or i == 0 or j == n:
                keep[i:j] = True
            i = j
        else:
            i += 1
    w = keep.astype(np.float32)
    k = np.ones(2 * ramp + 1, np.float32) / (2 * ramp + 1)
    return np.minimum(w, np.convolve(np.pad(w, ramp, mode="edge"), k, mode="valid")).astype(np.float32)


def viseme_closure_curve(cues: list[dict], n: int, fps: float, end_ms: float, min_rest_ms: float = 120.0) -> np.ndarray:
    """Optional hint for the audio driver: bilabials always close; long `rest` cues close."""
    w = np.zeros(n, np.float32)
    frame_ms = 1000.0 / fps
    for i, cue in enumerate(cues):
        t0 = float(cue["tMs"])
        t1 = float(cues[i + 1]["tMs"]) if i + 1 < len(cues) else end_ms
        if cue["viseme"] == "MBP" or (cue["viseme"] == "rest" and t1 - t0 >= min_rest_ms):
            a = int(math.floor(t0 / frame_ms + 0.5))
            b = max(int(math.floor(t1 / frame_ms + 0.5)), a + 1)
            w[max(a, 0):min(b, n)] = 1.0
    soft = np.convolve(np.pad(w, 1, mode="edge"), np.array([0.5, 1.0, 0.5], np.float32), mode="valid")
    return np.maximum(w, np.minimum(soft * 0.5, 0.5)).astype(np.float32)


class AudioDriver:
    name = "audio"

    def __init__(self, engine: LivePortrait, avatar: Avatar, wav16k: np.ndarray, fps: float, seed: int,
                 n_frames: int, visemes: list[dict] | None = None, steps: int = 50, on_stage=None,
                 check_canceled=None):
        self.engine, self.avatar = engine, avatar
        self.n_frames = n_frames
        lead_in = 5     # frames of silence generated before the clip; the first one is the neutral reference
        wav_pad = np.concatenate([np.zeros(lead_in * (SR // MODEL_FPS), np.float32), wav16k.astype(np.float32)])
        reg = get_registry()
        # HuBERT (1.46 GB) runs in ONNX Runtime on purpose: measured 2.2 GB peak instead of 2.9 GB
        # with OpenVINO (which also keeps bf16 copies), for ~0.5 s more per second of audio.
        # AVATAR_ENGINE_AUDIO_FEATURES_BACKEND=openvino trades that memory for speed.
        if os.environ.get("AVATAR_ENGINE_AUDIO_FEATURES_BACKEND", "onnxruntime").strip().lower() == "openvino":
            hubert = _heavy(reg.require(HUBERT), static_shapes={"input_values": [1, 6480]})
        else:
            hubert = backends.OrtModel(reg.require(HUBERT), allow_gpu=True)
        self.backends = {"hubert": hubert.backend}
        feats = self._audio_features(hubert, wav_pad, on_stage, check_canceled)
        del hubert
        backends.release_memory()
        lmdm = _heavy(reg.require(LMDM))
        self.backends["lmdm"] = lmdm.backend
        motion = self._audio_to_motion(lmdm, feats, steps, seed, on_stage, check_canceled)
        del lmdm
        backends.release_memory()
        self.d0 = motion[0].copy()
        motion = motion[lead_in:]
        # the motion model runs at 25 fps: resample the motion vectors (not pixels) to the target rate
        src_t = np.arange(len(motion)) / MODEL_FPS
        dst_t = np.minimum(np.arange(n_frames) / fps, src_t[-1])
        i0 = np.clip(np.floor(dst_t * MODEL_FPS).astype(int), 0, len(motion) - 1)
        i1 = np.minimum(i0 + 1, len(motion) - 1)
        a = (dst_t * MODEL_FPS - i0).astype(np.float32)[:, None]
        self.motion = (motion[i0] * (1 - a) + motion[i1] * a).astype(np.float32)
        close = silence_curve(wav16k, n_frames, fps)
        if visemes:
            close = np.maximum(close, viseme_closure_curve(visemes, n_frames, fps, len(wav16k) / SR * 1000.0))
        self.close = close

    # ---------- audio -> features ----------
    @staticmethod
    def _audio_features(hubert, wav: np.ndarray, on_stage, check_canceled) -> np.ndarray:
        """float32 mono 16 kHz -> (ceil(dur * 25), 1024): sliding 0.4 s window, 0.2 s hop."""
        n_f = math.ceil(len(wav) / SR * MODEL_FPS)
        split = int(10 * 0.04 * SR) + 80        # 6480 samples
        pad = np.concatenate([np.zeros(split - int(7 * 0.04 * SR), np.float32), wav, np.zeros(split, np.float32)])
        feats = []
        i = 0
        while i < n_f:
            if check_canceled:
                check_canceled()
            s = int(i * 0.04 * SR)
            enc = hubert({"input_values": pad[s:s + split].reshape(1, -1)})[0].reshape(-1, HUBERT_DIM)
            feats.append(enc[-14:-4].reshape(5, 2, HUBERT_DIM).mean(1))
            i += 5
            if on_stage:
                on_stage("features", min(1.0, i / n_f))
        return np.concatenate(feats, 0)[:n_f].astype(np.float32)

    # ---------- features -> motion ----------
    def _source_vec(self) -> np.ndarray:
        a = self.avatar
        return np.concatenate([[a.scale - 1.0], a.pose_bins[0], a.pose_bins[1], a.pose_bins[2], a.t.reshape(3),
                               a.exp.reshape(63)]).astype(np.float32)

    def _audio_to_motion(self, lmdm, feats: np.ndarray, steps: int, seed: int, on_stage, check_canceled,
                         emotion: int = 4, overlap: int = 10, smooth_k: int = 3) -> np.ndarray:
        a = self.avatar
        rng = np.random.default_rng(seed)
        n = len(feats)
        emo = np.zeros(8, np.float32)
        emo[emotion] = 8
        emo = _softmax(emo)
        # eyelid schedule (1 open .. 0 closed), deterministic from the seed
        blink = np.ones(n, np.float32)
        shape = (1.0, 0.45, 0.05, 0.0, 0.25, 0.7)
        i = 40
        while i + len(shape) < n - 10:
            blink[i:i + len(shape)] = shape
            i += len(shape) + int(rng.integers(60, 110))
        cond_all = np.concatenate([feats, np.tile(emo, (n, 1)), a.eye_open[None] * blink[:, None],
                                   np.tile(a.eye_ball, (n, 1)), np.tile(a.x_c.reshape(63), (n, 1))], 1)
        alphas = _cosine_alphas_cumprod()
        times = np.linspace(-1, 999, steps + 1).astype(np.int64)[::-1]
        pairs = list(zip(times[:-1], times[1:]))
        fixed_noise = [rng.standard_normal((1, SEQ, MOTION_DIM)).astype(np.float32) for _ in pairs]
        n_clips = max(1, math.ceil(max(n - overlap, 1) / (SEQ - overlap)))
        done = [0]

        def sample(cond: np.ndarray, kp_cond: np.ndarray) -> np.ndarray:
            x = rng.standard_normal((1, SEQ, MOTION_DIM)).astype(np.float32)
            for k, (t, t_next) in enumerate(pairs):       # DDIM, eta = 1
                if check_canceled:
                    check_canceled()
                eps, x0 = lmdm({"x": x, "cond_frame": kp_cond, "cond": cond,
                                "time_cond": np.array([t], np.int64)})[:2]
                if t_next < 0:
                    x = x0
                    break
                al, al_n = alphas[t], alphas[t_next]
                sigma = math.sqrt((1 - al / al_n) * (1 - al_n) / (1 - al))
                c = math.sqrt(max(1 - al_n - sigma ** 2, 0.0))
                x = (x0 * math.sqrt(al_n) + c * eps + sigma * fixed_noise[k]).astype(np.float32)
                done[0] += 1
                if on_stage and done[0] % 10 == 0:
                    on_stage("motion", min(1.0, done[0] / (n_clips * len(pairs))))
            return np.asarray(x, np.float32)

        def smooth(seq: np.ndarray, s: int, e: int) -> np.ndarray:
            src = seq.copy()
            half = smooth_k // 2
            for j in range(s, e):
                seq[:, j, :202] = src[:, max(0, j - half):min(seq.shape[1], j + half + 1), :202].mean(1)
            return seq

        valid = SEQ - overlap
        fuse = (np.arange(overlap, dtype=np.float32) / overlap).reshape(1, -1, 1)
        kp_cond = self._source_vec()[None]
        res = None
        idx = 0
        while idx < n:
            cond = cond_all[idx:idx + SEQ]
            if len(cond) < SEQ:
                cond = np.concatenate([cond, np.repeat(cond[-1:], SEQ - len(cond), 0)], 0)
            pred = sample(cond[None].astype(np.float32), kp_cond.astype(np.float32))
            if res is None:
                res = smooth(pred, 0, SEQ)
            else:
                res[:, -overlap:] = res[:, -overlap:] * (1 - fuse) + pred[:, :overlap] * fuse
                res = np.concatenate([res, pred[:, overlap:]], 1)
                res = smooth(res, res.shape[1] - valid - overlap, res.shape[1] - valid + 1)
            kp_cond = res[:, res.shape[1] - overlap - 1]
            idx += valid
        return smooth(res[:, :n], 0, n)[0]

    # ---------- motion -> keypoints ----------
    def keypoints(self, f: int) -> np.ndarray:
        a = self.avatar
        v, v0 = self.motion[f], self.d0
        pose = [bins_to_degrees(a.pose_bins[i] + (v[1 + 66 * i:67 + 66 * i] - v0[1 + 66 * i:67 + 66 * i]))
                for i in range(3)]
        t = a.t + (v[199:202] - v0[199:202])
        exp_d = a.exp + (v[202:265] - v0[202:265]).reshape(21, 3)
        exp = a.exp.copy()
        exp[KP_LIP + KP_EYE] = exp_d[KP_LIP + KP_EYE]       # only lips and eyes follow the audio motion
        close = float(self.close[f])
        if close > 0:
            exp[KP_LIP] = exp[KP_LIP] * (1 - close) + a.exp[KP_LIP] * close
        _gaze_compensation(exp, pose[1] - a.yaw, pose[0] - a.pitch)
        return transform_keypoints(a.x_c, rotation_matrix(*pose), exp, a.scale, t)
