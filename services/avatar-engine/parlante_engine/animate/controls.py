"""Deterministic control tracks from a Parlante viseme timeline: mouth shape (open / width /
round / teeth) with coarticulation, blinks, brows and head micro-motion.

Determinism: every function is a pure function of its arguments; randomness comes only from
`random.Random(seed)`. No wall-clock, no global state. Same input + seed => same tracks."""
from __future__ import annotations

import math
import random

import numpy as np

#: The 15 visemes of packages/shared/src/visemes.ts, in the same order.
VISEMES = ("rest", "MBP", "FV", "TH", "DT", "KG", "CHJ", "SZ", "NL", "R", "A", "E", "I", "O", "U")

#: VISEME_MOUTH_SHAPES of packages/shared/src/visemes.ts: open, width, round, teeth, tongue.
#: (tests/test_visemes.py parses the TypeScript file and checks this table against it.)
MOUTH_SHAPES = {
    "rest": (0.00, 0.00, 0.0, 0.0, 0.0),
    "MBP": (0.00, -0.05, 0.1, 0.0, 0.0),
    "FV": (0.12, 0.10, 0.0, 0.9, 0.0),
    "TH": (0.20, 0.10, 0.0, 0.5, 0.8),
    "DT": (0.22, 0.20, 0.0, 0.6, 0.4),
    "KG": (0.35, 0.10, 0.0, 0.3, 0.1),
    "CHJ": (0.25, -0.35, 0.6, 0.6, 0.0),
    "SZ": (0.10, 0.45, 0.0, 1.0, 0.0),
    "NL": (0.25, 0.15, 0.0, 0.4, 0.6),
    "R": (0.25, -0.20, 0.4, 0.2, 0.3),
    "A": (1.00, 0.15, 0.0, 0.3, 0.3),
    "E": (0.50, 0.50, 0.0, 0.5, 0.2),
    "I": (0.25, 0.75, 0.0, 0.7, 0.1),
    "O": (0.65, -0.45, 0.8, 0.0, 0.1),
    "U": (0.30, -0.75, 1.0, 0.0, 0.0),
}
#: How strongly a viseme imposes its own shape versus inheriting from neighbouring vowels.
DOMINANCE = {"rest": 1.0, "MBP": 1.0, "FV": 0.95, "TH": 0.7, "DT": 0.5, "KG": 0.35, "CHJ": 0.85, "SZ": 0.75,
             "NL": 0.5, "R": 0.55, "A": 1.0, "E": 1.0, "I": 1.0, "O": 1.0, "U": 1.0}
VOWELS = frozenset("AEIOU")
CHANNELS = ("open", "width", "round", "teeth")
#: The photoreal rig exaggerates less than a cartoon mouth: global gains per channel.
CHANNEL_GAIN = np.array([1.0, 0.9, 0.85, 0.9])


def frame_count(duration_ms: float, fps: float) -> int:
    """Frames needed to cover the audio completely (the clip is never shorter than the audio)."""
    return max(1, int(math.ceil(duration_ms / 1000.0 * fps - 1e-6)))


def normalize_cues(cues: list[dict], duration_ms: float) -> list[dict]:
    out = []
    for c in cues:
        v = c["viseme"]
        if v not in MOUTH_SHAPES:
            raise ValueError(f"unknown viseme {v!r}")
        t = float(c["tMs"])
        if t < 0 or not math.isfinite(t):
            raise ValueError("viseme cue times must be >= 0")
        out.append({"tMs": min(t, float(duration_ms)), "viseme": v})
    out.sort(key=lambda c: c["tMs"])                 # stable: keeps the given order for equal times
    if not out or out[0]["tMs"] > 0:
        out.insert(0, {"tMs": 0.0, "viseme": "rest"})
    return out


def mouth_tracks(cues: list[dict], duration_ms: float, fps: float, n_frames: int | None = None,
                 grid_hz: int = 200) -> np.ndarray:
    """cues: [{tMs, viseme}] (each shape holds until the next cue). Returns [n_frames, 4]:
    open / width / round / teeth per output frame (sampled at frame centres)."""
    cues = normalize_cues(cues, duration_ms)
    ends = [c["tMs"] for c in cues[1:]] + [float(duration_ms)]
    n = len(cues)
    # 1) coarticulated targets: weak consonants inherit from the neighbouring vowels
    targets = []
    for i, c in enumerate(cues):
        own = np.array(MOUTH_SHAPES[c["viseme"]][:4], dtype=np.float64)
        dom = DOMINANCE[c["viseme"]]
        if dom < 1.0:
            neigh = [np.array(MOUTH_SHAPES[cues[j]["viseme"]][:4]) for j in (i - 1, i + 1)
                     if 0 <= j < n and cues[j]["viseme"] in VOWELS]
            if neigh:
                ctx = np.mean(neigh, axis=0)
                ctx[0] = min(ctx[0], 0.45)          # a consonant never opens as much as the vowel
                own = dom * own + (1 - dom) * ctx
        targets.append(own * CHANNEL_GAIN)
    # 2) key points: reach the target shortly after the cue starts, hold until shortly before it ends
    keys_t: list[float] = []
    keys_v: list[np.ndarray] = []
    for c, e, tg in zip(cues, ends, targets):
        dur = max(e - c["tMs"], 1.0)
        attack = min(0.45 * dur, 55.0)
        release = min(0.25 * dur, 35.0)
        keys_t += [c["tMs"] + attack, max(c["tMs"] + attack, e - release)]
        keys_v += [tg, tg]
    rest = np.zeros(4)                               # the clip starts and ends at rest
    kt = np.array([-80.0] + keys_t + [duration_ms + 80.0])
    kt = np.maximum.accumulate(kt)
    kv = np.array([rest] + keys_v + [rest])
    # 3) sample on a fine grid with smoothstep easing between key points
    m = int(math.ceil(duration_ms / 1000 * grid_hz)) + 1
    grid_t = np.arange(m) * 1000.0 / grid_hz
    out = np.zeros((m, 4))
    lead = {0: 0.0, 1: 40.0, 2: 40.0, 3: 10.0}       # lips anticipate rounding/spreading (~40 ms before the jaw)
    for ch in range(4):
        tt = grid_t + lead[ch]
        idx = np.clip(np.searchsorted(kt, tt, side="right") - 1, 0, len(kt) - 2)
        t0, t1 = kt[idx], kt[idx + 1]
        u = np.where(t1 > t0, (tt - t0) / np.maximum(t1 - t0, 1e-6), 1.0)
        u = np.clip(u, 0, 1)
        u = u * u * (3 - 2 * u)
        out[:, ch] = kv[idx, ch] * (1 - u) + kv[idx + 1, ch] * u
    # 4) light low-pass (sigma 18 ms) removes velocity kinks
    sig = 0.018 * grid_hz
    k = np.arange(-int(3 * sig), int(3 * sig) + 1)
    w = np.exp(-0.5 * (k / sig) ** 2)
    w /= w.sum()
    for ch in range(4):
        out[:, ch] = np.convolve(np.pad(out[:, ch], len(k) // 2, mode="edge"), w, mode="valid")
    # 5) hard articulatory constraints: bilabials must really close, labiodentals nearly
    for c, e in zip(cues, ends):
        if c["viseme"] in ("MBP", "FV"):
            cap = 0.0 if c["viseme"] == "MBP" else 0.12
            mid = 0.5 * (c["tMs"] + e)
            half = max(0.5 * (e - c["tMs"]) - 12.0, 8.0)
            env = np.clip((np.abs(grid_t - mid) - half) / 45.0, 0, 1)      # 0 inside the closure
            env = env * env * (3 - 2 * env)
            out[:, 0] = np.minimum(out[:, 0], cap + env * 1.5)
    # 6) resample at frame centres; a closure shorter than a frame must still land on one frame
    nf = frame_count(duration_ms, fps) if n_frames is None else n_frames
    ft = (np.arange(nf) + 0.5) * 1000.0 / fps
    tracks = np.stack([np.interp(ft, grid_t, out[:, ch]) for ch in range(4)], axis=1)
    for c, e in zip(cues, ends):
        if c["viseme"] == "MBP" and e > c["tMs"]:
            f = int(np.clip(round((0.5 * (c["tMs"] + e)) / 1000.0 * fps - 0.5), 0, nf - 1))
            tracks[f, 0] = 0.0
    return np.clip(tracks, [0, -1, 0, 0], [1.2, 1, 1, 1]).astype(np.float32)


def _smoothstep(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def blink_track(n_frames: int, fps: float, seed: int) -> np.ndarray:
    """0 = open, 1 = closed. A blink every 2.2-4.8 s (seeded), fast close / slower open."""
    rng = random.Random(seed * 7919 + 13)
    track = np.zeros(n_frames, np.float32)
    t = rng.uniform(0.6, 1.6)
    dur = n_frames / fps
    while t < dur:
        f0 = max(0, int(t * fps) - 1)
        for f in range(f0, min(n_frames, f0 + int(0.4 * fps) + 3)):
            x = (f + 0.5) / fps - t
            if 0 <= x < 0.08:
                v = _smoothstep(x / 0.08)
            elif 0.08 <= x < 0.12:
                v = 1.0
            elif 0.12 <= x < 0.30:
                v = 1.0 - _smoothstep((x - 0.12) / 0.18)
            else:
                continue
            track[f] = max(track[f], v)
        t += rng.uniform(2.2, 4.8)
    return track


def words_from_cues(cues: list[dict], duration_ms: float) -> list[dict]:
    """Approximate word spans when the request carries no word timeline: stretches of speech
    between `rest` cues, split every ~450 ms."""
    cues = normalize_cues(cues, duration_ms)
    ends = [c["tMs"] for c in cues[1:]] + [float(duration_ms)]
    words: list[dict] = []
    start = None
    for c, e in zip(cues, ends):
        speaking = c["viseme"] != "rest"
        if speaking and start is None:
            start = c["tMs"]
        if start is not None and (not speaking or e - start >= 450.0 or e >= duration_ms):
            end = c["tMs"] if not speaking else e
            if end > start:
                words.append({"tMs": start, "durMs": end - start})
            start = None
    return words


def head_tracks(n_frames: int, fps: float, seed: int, words: list[dict] | None = None, amp: float = 1.0) -> dict:
    """Smooth pseudo-random head motion (sums of seeded sines), small nods on word onsets and
    occasional eyebrow raises. Per-frame arrays: pitch / yaw / roll (degrees), tx / ty, brow (0..1)."""
    rng = random.Random(seed * 104729 + 7)
    t = (np.arange(n_frames) + 0.5) / fps

    def noise(base_amp: float, freqs: tuple[float, ...]) -> np.ndarray:
        v = np.zeros(n_frames)
        for f in freqs:
            v += rng.uniform(0.5, 1.0) * np.sin(2 * math.pi * f * rng.uniform(0.85, 1.15) * t
                                                + rng.uniform(0, 2 * math.pi))
        return base_amp * v / len(freqs)

    pitch = noise(2.0 * amp, (0.13, 0.31, 0.57))
    yaw = noise(2.8 * amp, (0.09, 0.23, 0.41))
    roll = noise(1.2 * amp, (0.11, 0.27))
    tx = noise(0.004 * amp, (0.08, 0.19))
    ty = noise(0.003 * amp, (0.10, 0.22))
    brow = np.zeros(n_frames)
    for w in words or []:
        t0 = float(w["tMs"]) / 1000.0
        d = max(float(w.get("durMs", 250)) / 1000.0, 0.15)
        if rng.random() < 0.45:                       # nod on this word
            a = rng.uniform(0.8, 1.8) * amp
            pitch += a * np.exp(-0.5 * ((t - (t0 + 0.4 * d)) / 0.13) ** 2)
        if rng.random() < 0.22:                       # emphasis: brows up
            brow += rng.uniform(0.5, 1.0) * np.exp(-0.5 * ((t - (t0 + 0.3 * d)) / 0.22) ** 2)
    # start and end close to the portrait's own pose so clips cut cleanly against the still image
    edge = np.clip(np.minimum(t, t[-1] - t + 0.5 / fps) / 0.35, 0, 1)
    edge = edge * edge * (3 - 2 * edge)
    f32 = lambda a: np.asarray(a, np.float32)  # noqa: E731
    return {"pitch": f32(pitch * edge), "yaw": f32(yaw * edge), "roll": f32(roll * edge), "tx": f32(tx * edge),
            "ty": f32(ty * edge), "brow": f32(np.clip(brow, 0, 1))}


def build_controls(cues: list[dict], duration_ms: float, fps: float, seed: int, words: list[dict] | None = None,
                   n_frames: int | None = None, head_amp: float = 1.0) -> dict:
    """All per-frame control tracks of a clip. Pure function of its arguments."""
    n = frame_count(duration_ms, fps) if n_frames is None else n_frames
    if words is None:
        words = words_from_cues(cues, duration_ms)
    ctl = head_tracks(n, fps, seed, words, amp=head_amp)
    ctl["blink"] = blink_track(n, fps, seed)
    ctl["mouth"] = mouth_tracks(cues, duration_ms, fps, n_frames=n)
    return ctl


def controls_digest(ctl: dict) -> str:
    import hashlib
    h = hashlib.sha256()
    for key in sorted(ctl):
        h.update(key.encode())
        h.update(np.ascontiguousarray(ctl[key], dtype=np.float32).tobytes())
    return h.hexdigest()
