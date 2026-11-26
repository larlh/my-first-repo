"""The two drivers. Both turn their input into per-frame DRIVING KEYPOINTS for the same
generator; everything after that (stitching, rendering, paste-back, matte, encoding) is shared.

  VisemeDriver  Parlante viseme timeline -> deterministic rig animation.
  AudioDriver   WAV -> HuBERT features -> LMDM motion diffusion (Ditto) -> lip motion that
                follows the sound itself. Loads ~1.7 GB of extra weights lazily and frees them
                before rendering starts. Two motion modes:
                  "lips"  (default) only the LIPS come from the audio model; blinks, brows and
                          head micro-motion come from the same seeded control tracks as the
                          viseme driver (small, deterministic, never drifts against the shoulders).
                          WHEN and HOW the mouth moves is the audio model's; HOW MUCH it opens is
                          put through the avatar's own mouth calibration and normalised per clip,
                          because the raw displacement opens some faces half as much as others.
                  "full"  lips, eyes and head pose all come from the audio model, untouched
"""
from __future__ import annotations

import math
import os
import time

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
LEAD_IN = 5            # motion frames generated from silence before the clip (neutral reference first)


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
    """Per-frame lip-closure weight from audio energy: 0 while there is speech, rising inside a
    pause to exactly 1 (`ramp` frames after the last sound) and falling back before the next one,
    so a phrase ends and the next begins without a jump. Gaps shorter than 120 ms (stop
    consonants) are not pauses; the clip's own lead-in and tail always are."""
    hop = SR / fps
    rms = np.zeros(n)
    for i in range(n):
        seg = wav[int(i * hop):int((i + 1) * hop)]
        rms[i] = math.sqrt(float(np.mean(seg ** 2)) + 1e-12) if len(seg) else 0.0
    db = 20 * np.log10(rms / (rms.max() + 1e-12) + 1e-6)
    sil = db < thresh_db
    min_frames = max(3, int(round(0.12 * fps)))
    w = np.zeros(n, np.float32)
    i = 0
    while i < n:
        if not sil[i]:
            i += 1
            continue
        j = i
        while j < n and sil[j]:
            j += 1
        if j - i >= min_frames or i == 0 or j == n:
            k = np.arange(i, j)
            # frames since the last sound / until the next one (the clip's edges are not sounds)
            since = k - i + 1 if i > 0 else np.full(j - i, ramp)
            until = j - k if j < n else np.full(j - i, ramp)
            w[i:j] = np.clip(np.minimum(since, until) / float(ramp), 0.0, 1.0)
        i = j
    return w


def resample_motion(motion: np.ndarray, n_frames: int, fps: float, advance_ms: float = 0.0) -> np.ndarray:
    """Motion vectors at the model's 25 fps -> one per output frame, by TIME. Motion vector k
    describes the audio of [k, k+1) / 25 s and output frame f is on screen during [f, f+1) / fps,
    so each output frame takes the motion at its own centre. `advance_ms` > 0 shows the motion
    that much earlier (lips ahead of the sound)."""
    pos = ((np.arange(n_frames) + 0.5) / fps + advance_ms / 1000.0) * MODEL_FPS - 0.5
    pos = np.clip(pos, 0.0, len(motion) - 1.0)
    i0 = np.floor(pos).astype(int)
    i1 = np.minimum(i0 + 1, len(motion) - 1)
    a = (pos - i0).astype(np.float32)[:, None]
    return (motion[i0] * (1 - a) + motion[i1] * a).astype(np.float32)


def lip_opening_proxy(motion: np.ndarray, d0: np.ndarray, direction: np.ndarray) -> np.ndarray:
    """Scalar "how open is the mouth" per frame of the audio model's motion: the projection of its
    lip-keypoint displacement on the direction in which the lip-retargeting MLP opens this face."""
    delta = (motion[:, 202:265] - d0[202:265]).reshape(len(motion), 21, 3)[:, KP_LIP].reshape(len(motion), -1)
    return (delta @ direction).astype(np.float32)


#: Lip ratio (inner-lip gap / mouth width) that clear speech reaches on its open vowels: the 90th
#: percentile of the opening while speaking is brought to this, within ARTICULATION_RANGE.
ARTICULATION_P90 = 0.30
ARTICULATION_RANGE = (0.85, 1.75)
LIP_RATIO_MAX = 0.6


def articulation_gain(nominal: np.ndarray, close: np.ndarray) -> float:
    """Per-clip gain that brings the audio model's mouth opening to the level of clear speech.

    The same sentence makes the audio model open some faces half as much as others (measured:
    0.20 vs 0.13 mean lip ratio on two stock avatars), which reads as mumbling. The gain is
    bounded, so a clip that really is quiet — or too short to judge — is not blown up."""
    speaking = nominal[(close < 0.5) & (nominal > 0.0)]
    if len(speaking) < 8:
        return 1.0
    p90 = float(np.percentile(speaking, 90))
    if p90 < 1e-3:
        return 1.0
    return float(np.clip(ARTICULATION_P90 / p90, *ARTICULATION_RANGE))


def snap_bilabial_closures(opening: np.ndarray, cues: list[dict], fps: float, end_ms: float,
                           window_ms: float = 90.0, trusted: bool = False) -> np.ndarray:
    """Closure weights (0..1 per frame) for the bilabials of a viseme timeline.

    `trusted` False — the timing may be ESTIMATED (or simply late): each /p b m/ cue closes the
    lips on the frame where the audio-driven opening is lowest within +-`window_ms` of the cue,
    i.e. where the sound itself says the lips meet. A cue with no dip nearby (the opening there
    is above 60 % of the clip's range) is ignored rather than forcing a closure inside a vowel.
    `trusted` True — the timeline is known to follow the sound (see `service.TIMELINE_TRUST_FIT`):
    every cue closes the lips, on the lowest frame within one frame of its own instant."""
    n = len(opening)
    w = np.zeros(n, np.float32)
    if n == 0:
        return w
    lo, hi = float(opening.min()), float(np.percentile(opening, 95))
    span = max(hi - lo, 1e-9)
    frame_ms = 1000.0 / fps
    if trusted:
        window_ms = frame_ms
    for i, cue in enumerate(cues):
        if cue["viseme"] != "MBP":
            continue
        t0 = float(cue["tMs"])
        t1 = float(cues[i + 1]["tMs"]) if i + 1 < len(cues) else end_ms
        mid = 0.5 * (t0 + t1)
        a = max(0, int(math.floor((mid - window_ms) / frame_ms)))
        b = min(n, int(math.ceil((mid + window_ms) / frame_ms)) + 1)
        if trusted:                       # the cue's own frame and its two neighbours
            centre = int(np.clip(round(mid / frame_ms - 0.5), 0, n - 1))
            a, b = max(0, centre - 1), min(n, centre + 2)
        if b <= a:
            continue
        f = a + int(np.argmin(opening[a:b]))
        if not trusted and (float(opening[f]) - lo) / span > 0.6:
            continue
        w[f] = 1.0
        for g, v in ((f - 1, 0.5), (f + 1, 0.5)):
            if 0 <= g < n:
                w[g] = max(w[g], v)
    return w


class AudioDriver:
    name = "audio"

    def __init__(self, engine: LivePortrait, avatar: Avatar, wav16k: np.ndarray, fps: float, seed: int,
                 n_frames: int, visemes: list[dict] | None = None, steps: int = 50, on_stage=None,
                 check_canceled=None, words: list[dict] | None = None, motion_mode: str = "lips",
                 lip_gain: float = 1.0, lip_advance_ms: float = 0.0, motion: np.ndarray | None = None,
                 lip_drive: str = "calibrated", timeline_trusted: bool = False):
        """`motion` (tests, tools): motion vectors [n, 265] at 25 fps whose first row is the neutral
        reference, instead of running the audio model on `wav16k`."""
        if motion_mode not in ("lips", "full"):
            raise ValueError(f"unknown audio motion mode {motion_mode!r}")
        if lip_drive not in ("calibrated", "raw"):
            raise ValueError(f"unknown lip drive {lip_drive!r}")
        self.engine, self.avatar = engine, avatar
        self.n_frames = n_frames
        self.motion_mode = motion_mode
        self.lip_gain = float(lip_gain)
        duration_ms = len(wav16k) / SR * 1000.0
        self.backends: dict = {}
        self.timings: dict = {}
        if motion is None:
            motion = self._run_models(wav16k, steps, seed, on_stage, check_canceled)
        self.d0 = motion[0].copy()
        motion = motion[LEAD_IN:]
        self.motion = resample_motion(motion, n_frames, fps, lip_advance_ms)
        # lips rest exactly on the portrait's own mouth in pauses (no tremble) ...
        close = silence_curve(wav16k, n_frames, fps)
        open_dir, open_unit = self._opening_direction()
        self.opening = lip_opening_proxy(self.motion, self.d0, open_dir)
        if visemes:
            # ... and meet on /p b m/. A timeline that is known to follow the sound closes them on its
            # own instants; one that may be estimated or late only where the audio-driven motion
            # itself narrows the lips.
            close = np.maximum(close, snap_bilabial_closures(self.opening, visemes, fps, duration_ms,
                                                             trusted=timeline_trusted))
        self.close = close
        self.lip_drive = lip_drive if motion_mode == "lips" else "raw"
        if motion_mode == "lips":
            self.rig = Rig(avatar.calib)
            self.ctl = {**C.head_tracks(n_frames, fps, seed, words if words is not None
                                        else C.words_from_cues(visemes or [], duration_ms)),
                        "blink": C.blink_track(n_frames, fps, seed)}
            self.eye_closed = engine.eye_delta(avatar.x_s, float(avatar.eye_ratio[0]), float(avatar.eye_ratio[1]), 0.0)
        if self.lip_drive == "calibrated":
            # Opening asked by the audio model, as the lip ratio the retargeting MLP would give it
            lips = (self.motion[:, 202:265] - self.d0[202:265]).reshape(n_frames, 21, 3)[:, KP_LIP]
            nominal = np.clip(self.opening.astype(np.float64) * open_unit, 0.0, None)
            #: what is left of the lip motion once the opening is taken out: spreading, rounding
            self.lip_shape = (lips.reshape(n_frames, -1) - np.outer(self.opening, open_dir)).reshape(
                n_frames, len(KP_LIP), 3).astype(np.float32)
            self.articulation = articulation_gain(nominal, close)
            self.lip_ratio = np.clip(nominal * self.articulation * self.lip_gain, 0.0, LIP_RATIO_MAX) * (1.0 - close)
            self._lip_cache: dict[int, np.ndarray] = {}

    def _opening_direction(self) -> tuple[np.ndarray, float]:
        """Unit direction (lip keypoints, expression space) in which the lip-retargeting MLP opens
        this face, and the lip ratio one unit of displacement along it stands for."""
        a = self.avatar
        d = (self.engine.lip_delta(a.x_s, a.lip_ratio, 0.35) - self.engine.lip_delta(a.x_s, a.lip_ratio, 0.0))
        d = (d[KP_LIP] / max(a.scale, 1e-6)).reshape(-1).astype(np.float64)
        norm = float(np.linalg.norm(d)) + 1e-12
        return d / norm, 0.35 / norm

    def _lip(self, ratio: float) -> np.ndarray:
        target = self.rig.ratio_to_target(ratio)
        key = int(round(target * 4000))
        hit = self._lip_cache.get(key)
        if hit is None:
            hit = self.engine.lip_delta(self.avatar.x_s, self.avatar.lip_ratio, key / 4000.0)
            self._lip_cache[key] = hit
        return hit

    def _run_models(self, wav16k: np.ndarray, steps: int, seed: int, on_stage, check_canceled) -> np.ndarray:
        """WAV -> motion vectors at 25 fps, preceded by LEAD_IN frames generated from silence (the
        first one is the neutral reference every displacement is measured against)."""
        wav_pad = np.concatenate([np.zeros(LEAD_IN * (SR // MODEL_FPS), np.float32), wav16k.astype(np.float32)])
        reg = get_registry()
        # HuBERT (1.46 GB) runs in ONNX Runtime on purpose: measured 2.2 GB peak instead of 2.9 GB
        # with OpenVINO (which also keeps bf16 copies), for ~0.5 s more per second of audio.
        # AVATAR_ENGINE_AUDIO_FEATURES_BACKEND=openvino trades that memory for speed.
        t0 = time.monotonic()
        if os.environ.get("AVATAR_ENGINE_AUDIO_FEATURES_BACKEND", "onnxruntime").strip().lower() == "openvino":
            hubert = _heavy(reg.require(HUBERT), static_shapes={"input_values": [1, 6480]})
        else:
            hubert = backends.OrtModel(reg.require(HUBERT), allow_gpu=True)
        self.backends = {"hubert": hubert.backend}
        t1 = time.monotonic()
        feats = self._audio_features(hubert, wav_pad, on_stage, check_canceled)
        del hubert
        backends.release_memory()
        t2 = time.monotonic()
        lmdm = _heavy(reg.require(LMDM))
        self.backends["lmdm"] = lmdm.backend
        t3 = time.monotonic()
        motion = self._audio_to_motion(lmdm, feats, steps, seed, on_stage, check_canceled)
        del lmdm
        backends.release_memory()
        #: Where the set-up time of this clip went (seconds): model loads and the two inference stages.
        self.timings = {"featuresLoad": round(t1 - t0, 2), "features": round(t2 - t1, 2),
                        "motionLoad": round(t3 - t2, 2), "motion": round(time.monotonic() - t3, 2)}
        return motion

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
        exp_d = a.exp + (v[202:265] - v0[202:265]).reshape(21, 3)
        exp = a.exp.copy()
        close = float(self.close[f])
        if self.motion_mode == "full":
            pose = [bins_to_degrees(a.pose_bins[i] + (v[1 + 66 * i:67 + 66 * i] - v0[1 + 66 * i:67 + 66 * i]))
                    for i in range(3)]
            t = a.t + (v[199:202] - v0[199:202])
            exp[KP_LIP + KP_EYE] = exp_d[KP_LIP + KP_EYE]       # only lips and eyes follow the audio motion
            if close > 0:
                exp[KP_LIP] = exp[KP_LIP] * (1 - close) + a.exp[KP_LIP] * close
            _gaze_compensation(exp, pose[1] - a.yaw, pose[0] - a.pitch)
            return transform_keypoints(a.x_c, rotation_matrix(*pose), exp, a.scale, t)
        # "lips": the mouth follows the audio, everything else is the seeded rig of the viseme driver
        ctl = self.ctl
        if self.lip_drive == "calibrated":
            exp[KP_LIP] = a.exp[KP_LIP] + (1.0 - close) * self.lip_shape[f]
        else:
            exp[KP_LIP] = a.exp[KP_LIP] + self.lip_gain * (1.0 - close) * (exp_d[KP_LIP] - a.exp[KP_LIP])
        exp += float(ctl["brow"][f]) * self.rig.bases["brow_up"]
        d_pitch, d_yaw, d_roll = float(ctl["pitch"][f]), float(ctl["yaw"][f]), float(ctl["roll"][f])
        _gaze_compensation(exp, d_yaw, d_pitch)
        t = a.t.copy()
        t[0] += float(ctl["tx"][f])
        t[1] += float(ctl["ty"][f])
        x_d = transform_keypoints(a.x_c, rotation_matrix(a.pitch + d_pitch, a.yaw + d_yaw, a.roll + d_roll),
                                  exp, a.scale, t)
        if self.lip_drive == "calibrated":
            x_d = x_d + self._lip(float(self.lip_ratio[f]))      # opening through the avatar's calibration
        blink = float(ctl["blink"][f])
        if blink > 1e-3:
            x_d = x_d + blink * self.eye_closed
        return x_d.astype(np.float32)
