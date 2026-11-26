"""LivePortrait maths and the per-portrait state ("avatar"): own numpy implementation around
the ONNX sub-graphs. Graph signatures (confirmed with onnxruntime):

  appearance_feature_extractor  img[1,3,256,256] -> feature_3d[1,32,16,64,64]
  motion_extractor              img[1,3,256,256] -> pitch/yaw/roll[1,66] (bin logits), t[1,3],
                                                    exp[1,63], scale[1,1], kp[1,63]
  stitching                     [1,126] -> [1,65]
  stitching_lip                 [1,65]  -> [1,63]   (kp_source + (source ratio, target ratio))
  stitching_eye                 [1,66]  -> [1,63]   (kp_source + (left, right, target))
"""
from __future__ import annotations

import hashlib
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from parlante_engine.core.backends import ort_session
from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import EngineError
from parlante_engine.core.registry import get_registry
from parlante_engine.prepare.face import face_metrics, get_face_landmarker

from .generator import Generator
from .models import APPEARANCE, MOTION, STITCHING, STITCHING_EYE, STITCHING_LIP

CROP = 512
AVATAR_CACHE_VERSION = 3
#: Lip-MLP targets rendered once per avatar to calibrate "mouth opening" (see Rig).
CALIBRATION_TARGETS = (0.0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8)


def rotation_matrix(pitch_deg: float, yaw_deg: float, roll_deg: float) -> np.ndarray:
    """Head rotation of the model family: R = (Rz @ Ry @ Rx)^T, applied as kp @ R."""
    x, y, z = (math.radians(v) for v in (pitch_deg, yaw_deg, roll_deg))
    rx = np.array([[1, 0, 0], [0, math.cos(x), -math.sin(x)], [0, math.sin(x), math.cos(x)]])
    ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rz = np.array([[math.cos(z), -math.sin(z), 0], [math.sin(z), math.cos(z), 0], [0, 0, 1]])
    return (rz @ ry @ rx).T.astype(np.float32)


def bins_to_degrees(logits: np.ndarray) -> float:
    logits = np.asarray(logits, np.float64).reshape(-1)
    e = np.exp(logits - logits.max())
    p = e / e.sum()
    return float((p * np.arange(66)).sum() * 3.0 - 97.5)


def transform_keypoints(x_c: np.ndarray, rot: np.ndarray, exp: np.ndarray, scale: float, t: np.ndarray) -> np.ndarray:
    x = (x_c @ rot + exp) * scale
    x[:, :2] += t[None, :2]               # tz is ignored by the model family
    return x.astype(np.float32)


def crop_transform(lm: np.ndarray, dsize: int = CROP, scale: float = 2.3, vy_ratio: float = -0.125) -> np.ndarray:
    """2x3 affine portrait -> generator crop: roll-aligned landmark box, enlarged and shifted up."""
    eye_l = lm[[33, 133]].mean(0)[:2]
    eye_r = lm[[263, 362]].mean(0)[:2]
    ang = math.atan2(eye_r[1] - eye_l[1], eye_r[0] - eye_l[0])
    c, s = math.cos(-ang), math.sin(-ang)
    rot = np.array([[c, -s], [s, c]], dtype=np.float32)
    pts = lm[:468, :2] @ rot.T
    mn, mx = pts.min(0), pts.max(0)
    size = float(max(mx - mn)) * scale
    center = (mn + mx) / 2 + np.array([0, vy_ratio * size], dtype=np.float32)
    k = dsize / size
    m = np.zeros((2, 3), dtype=np.float32)
    m[:, :2] = k * rot
    m[:, 2] = -k * center + dsize / 2
    return m


def paste_mask(dsize: int = CROP) -> np.ndarray:
    """Soft mask in crop space: 1 in the centre, feathered to exactly 0 at the border."""
    m = np.zeros((dsize, dsize), np.float32)
    b = int(dsize * 0.08)
    cv2.rectangle(m, (b, b), (dsize - b - 1, dsize - b - 1), 1.0, -1)
    k = int(dsize * 0.11) | 1
    m = cv2.GaussianBlur(m, (k, k), 0)
    idx = np.arange(dsize, dtype=np.float32)
    border = np.minimum(idx, dsize - 1 - idx)
    edge = np.minimum(border[None, :], border[:, None])
    return np.clip(m * np.clip(edge / 6.0, 0, 1), 0, 1).astype(np.float32)


def eye_attributes(lm_norm: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Normalised 478 landmarks -> eye_open (2,), eye_ball (6,): conditions of the audio model."""
    def dist(a, b):
        return float(np.linalg.norm(lm_norm[a] - lm_norm[b]))

    def unit(v):
        return v / (np.linalg.norm(v) + 1e-8)

    l_w, r_w = dist(33, 133), dist(263, 362)
    l_open = (dist(145, 159) + dist(144, 160) + dist(153, 158)) / (l_w + 1e-8)
    r_open = (dist(374, 386) + dist(373, 387) + dist(380, 385)) / (r_w + 1e-8)
    l_c, r_c = (lm_norm[33] + lm_norm[133]) / 2, (lm_norm[263] + lm_norm[362]) / 2
    l_b, r_b = lm_norm[468], lm_norm[473]
    l_move = (unit(l_b - l_c) - unit(lm_norm[33] - lm_norm[133])) * np.linalg.norm(l_b - l_c)
    r_move = (unit(r_b - r_c) - unit(lm_norm[263] - lm_norm[362])) * np.linalg.norm(r_b - r_c)
    return (np.array([l_open, r_open], np.float32),
            np.stack([l_move, r_move], -1).reshape(6).astype(np.float32))


@dataclass
class Avatar:
    """Everything that depends only on the portrait. Computed once (by `prepare`) and cached."""

    portrait_sha256: str
    width: int
    height: int
    m_c2o: np.ndarray            # 2x3 affine: generator crop -> portrait pixels
    f_s: np.ndarray              # [1,32,16,64,64]
    x_c: np.ndarray              # canonical keypoints [21,3]
    exp: np.ndarray              # [21,3]
    pose_bins: np.ndarray        # [3,66] raw pitch/yaw/roll logits (the audio model conditions on them)
    t: np.ndarray                # [3]
    scale: float
    lip_ratio: float
    eye_ratio: np.ndarray        # [2]
    eye_open: np.ndarray         # [2]  audio-model condition
    eye_ball: np.ndarray         # [6]
    landmarks: np.ndarray        # [478,3] portrait pixels
    calib: np.ndarray            # [n,2] lip MLP target -> achieved lip ratio
    pitch: float = field(init=False)
    yaw: float = field(init=False)
    roll: float = field(init=False)
    x_s: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.pitch, self.yaw, self.roll = (bins_to_degrees(self.pose_bins[i]) for i in range(3))
        self.x_s = transform_keypoints(self.x_c, rotation_matrix(self.pitch, self.yaw, self.roll), self.exp,
                                       self.scale, self.t)

    ARRAYS = ("m_c2o", "f_s", "x_c", "exp", "pose_bins", "t", "eye_ratio", "eye_open", "eye_ball", "landmarks",
              "calib")

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp.npz")
        np.savez(tmp, version=np.int64(AVATAR_CACHE_VERSION), width=np.int64(self.width), height=np.int64(self.height),
                 scale=np.float64(self.scale), lip_ratio=np.float64(self.lip_ratio),
                 **{k: getattr(self, k) for k in self.ARRAYS})
        tmp.replace(path)

    @classmethod
    def load(cls, path: Path, sha: str) -> "Avatar | None":
        try:
            with np.load(path, allow_pickle=False) as z:
                if int(z["version"]) != AVATAR_CACHE_VERSION:
                    return None
                return cls(portrait_sha256=sha, width=int(z["width"]), height=int(z["height"]),
                           scale=float(z["scale"]), lip_ratio=float(z["lip_ratio"]),
                           **{k: z[k].copy() for k in cls.ARRAYS})
        except (OSError, KeyError, ValueError):
            return None


def avatar_cache_path(sha: str) -> Path:
    return get_settings().work_dir / ".cache" / "avatars" / f"{sha}.npz"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class LivePortrait:
    """Small networks + generator. One instance per process (see get_engine)."""

    def __init__(self, threads: int | None = None):
        reg = get_registry()
        threads = threads or get_settings().threads
        self.s_app = ort_session(reg.require(APPEARANCE), threads)
        self.s_mot = ort_session(reg.require(MOTION), threads)
        self.s_stitch = ort_session(reg.require(STITCHING), 1)
        self.s_lip = ort_session(reg.require(STITCHING_LIP), 1)
        self.s_eye = ort_session(reg.require(STITCHING_EYE), 1)
        self.generator = Generator(threads)
        self.mask512 = paste_mask()

    # ---------- keypoint networks ----------
    def stitch(self, x_s: np.ndarray, x_d: np.ndarray) -> np.ndarray:
        inp = np.concatenate([x_s.reshape(1, 63), x_d.reshape(1, 63)], axis=1).astype(np.float32)
        d = self.s_stitch.run(None, {"input": inp})[0][0]
        out = x_d + d[:63].reshape(21, 3)
        out[:, :2] += d[63:65][None]
        return out.astype(np.float32)

    def lip_delta(self, x_s: np.ndarray, src_ratio: float, tgt_ratio: float) -> np.ndarray:
        inp = np.concatenate([x_s.reshape(1, 63), [[src_ratio, tgt_ratio]]], axis=1).astype(np.float32)
        return self.s_lip.run(None, {"input": inp})[0].reshape(21, 3)

    def eye_delta(self, x_s: np.ndarray, src_l: float, src_r: float, tgt: float) -> np.ndarray:
        inp = np.concatenate([x_s.reshape(1, 63), [[src_l, src_r, tgt]]], axis=1).astype(np.float32)
        return self.s_eye.run(None, {"input": inp})[0].reshape(21, 3)

    # ---------- portrait registration ----------
    def head_pose(self, bgr: np.ndarray, lm: np.ndarray) -> tuple[float, float, float]:
        """Pitch, yaw, roll in degrees of the face inside the roll-aligned generator crop."""
        crop = cv2.warpAffine(bgr, crop_transform(lm), (CROP, CROP), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_REPLICATE)
        x = self._to_input(crop)
        pitch, yaw, roll = self.s_mot.run(None, {"img": x})[:3]
        return bins_to_degrees(pitch), bins_to_degrees(yaw), bins_to_degrees(roll)

    @staticmethod
    def _to_input(crop_bgr512: np.ndarray) -> np.ndarray:
        rgb256 = cv2.resize(cv2.cvtColor(crop_bgr512, cv2.COLOR_BGR2RGB), (256, 256), interpolation=cv2.INTER_AREA)
        return (rgb256.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]

    def register(self, bgr: np.ndarray, lm: np.ndarray, sha: str, on_step=None) -> Avatar:
        """Portrait (BGR) + its 478 landmarks -> Avatar (includes the 7 calibration renders)."""
        h, w = bgr.shape[:2]
        m_o2c = crop_transform(lm)
        crop = cv2.warpAffine(bgr, m_o2c, (CROP, CROP), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        x = self._to_input(crop)
        f_s = self.s_app.run(None, {"img": x})[0]
        pitch, yaw, roll, t, exp, scale, kp = self.s_mot.run(None, {"img": x})
        lm_crop = np.concatenate([lm[:, :2] @ m_o2c[:, :2].T + m_o2c[:, 2], lm[:, 2:3] * float(np.linalg.norm(m_o2c[0, :2]))], 1)
        eye_open, eye_ball = eye_attributes(lm_crop / float(CROP))
        met = face_metrics(lm)
        avatar = Avatar(
            portrait_sha256=sha, width=w, height=h, m_c2o=cv2.invertAffineTransform(m_o2c).astype(np.float32),
            f_s=f_s.astype(np.float32), x_c=kp.reshape(21, 3).copy(), exp=exp.reshape(21, 3).copy(),
            pose_bins=np.stack([pitch[0], yaw[0], roll[0]]).astype(np.float32), t=t[0].copy(),
            scale=float(scale[0, 0]), lip_ratio=float(met["lip_ratio"]),
            eye_ratio=np.array([met["eye_l"], met["eye_r"]], np.float32), eye_open=eye_open, eye_ball=eye_ball,
            landmarks=lm.astype(np.float32), calib=np.zeros((0, 2), np.float32))
        avatar.calib = self._calibrate_open(avatar, on_step)
        return avatar

    def _calibrate_open(self, avatar: Avatar, on_step=None) -> np.ndarray:
        """Which inner-lip ratio does each lip-MLP target really produce on this face?"""
        mesh = get_face_landmarker()
        rows = []
        for i, target in enumerate(CALIBRATION_TARGETS):
            x_d = self.stitch(avatar.x_s, avatar.x_s + self.lip_delta(avatar.x_s, avatar.lip_ratio, target))
            frame = self.render(avatar, x_d)
            lm = mesh.landmarks(frame)
            rows.append((target, face_metrics(lm)["lip_ratio"] if lm is not None else target))
            if on_step:
                on_step(i + 1, len(CALIBRATION_TARGETS))
        return np.array(rows, np.float32)

    # ---------- rendering ----------
    def render(self, avatar: Avatar, x_d: np.ndarray) -> np.ndarray:
        """Driving keypoints (already stitched) -> RGB uint8 512x512 crop."""
        return self.generator(avatar.f_s, x_d[None], avatar.x_s[None])


class Paster:
    """Pastes generated crops back on the (optionally downscaled) portrait. Output is BGR."""

    def __init__(self, avatar: Avatar, portrait_bgr: np.ndarray, out_w: int, out_h: int):
        self.out_w, self.out_h = out_w, out_h
        sx, sy = out_w / avatar.width, out_h / avatar.height
        m = avatar.m_c2o.astype(np.float64).copy()
        m[0] *= sx
        m[1] *= sy
        self.m_c2o = m
        interp = cv2.INTER_AREA if sx < 1 else cv2.INTER_LINEAR
        self.base = cv2.resize(portrait_bgr, (out_w, out_h), interpolation=interp)
        mask = cv2.warpAffine(paste_mask(), m, (out_w, out_h), flags=cv2.INTER_LINEAR)
        ys, xs = np.where(mask > 1e-3)
        if len(xs) == 0:
            raise EngineError("UNPROCESSABLE", "The face region falls outside the portrait.", "face_outside")
        self.bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        x0, y0, x1, y1 = self.bbox
        self.mask = mask[y0:y1, x0:x1, None]
        self.m_local = m.copy()
        self.m_local[:, 2] -= (x0, y0)
        self.base_f = self.base[y0:y1, x0:x1].astype(np.float32)
        # anti-aliased downscale when the crop lands on fewer output pixels than it has
        self.crop_scale = float(np.linalg.norm(m[0, :2]))
        self.sharpen = float(get_settings().sharpen)

    def paste(self, frame_rgb512: np.ndarray) -> np.ndarray:
        x0, y0, x1, y1 = self.bbox
        src = cv2.cvtColor(frame_rgb512, cv2.COLOR_RGB2BGR)
        if self.sharpen > 0:
            # unsharp mask: the SPADE decoder output is visibly softer than the photo around it
            f = src.astype(np.float32)
            src = np.clip(f + self.sharpen * (f - cv2.GaussianBlur(f, (0, 0), 1.2)), 0, 255).astype(np.uint8)
        m = self.m_local
        if self.crop_scale < 0.75:
            k = max(self.crop_scale, 0.25)
            src = cv2.resize(src, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
            m = m.copy()
            m[:, :2] /= k
        warped = cv2.warpAffine(src, m, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        out = self.base.copy()
        out[y0:y1, x0:x1] = (warped * self.mask + self.base_f * (1.0 - self.mask) + 0.5).astype(np.uint8)
        return out

    def warp_to_output(self, crop_img: np.ndarray, border_value=0) -> np.ndarray:
        """Warp any crop-space single-channel image to output space (full frame)."""
        return cv2.warpAffine(crop_img, self.m_c2o, (self.out_w, self.out_h), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=border_value)


_engine: LivePortrait | None = None
_engine_lock = threading.Lock()


def get_engine() -> LivePortrait:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = LivePortrait()
        return _engine


def engine_loaded() -> bool:
    return _engine is not None
