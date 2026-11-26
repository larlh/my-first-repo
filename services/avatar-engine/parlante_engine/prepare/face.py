"""Face detection + 478 landmarks with the MediaPipe BlazeFace / FaceMesh graphs executed in
ONNX Runtime (own pre/post-processing: no mediapipe wheel, no system GL libraries)."""
from __future__ import annotations

import threading
from dataclasses import dataclass

import cv2
import numpy as np

from parlante_engine.core.backends import ort_session
from parlante_engine.core.registry import get_registry

from .models import BLAZE_FACE, FACE_MESH

# FaceMesh indices
L_EYE = (33, 133, 159, 145)        # image-left eye: outer, inner, upper lid, lower lid
R_EYE = (263, 362, 386, 374)
MOUTH = (61, 291, 13, 14)          # image-left corner, right corner, upper inner lip, lower inner lip
CHIN = 152
NOSE_TIP = 1


@dataclass
class Detection:
    score: float
    box: np.ndarray        # x0, y0, x1, y1 in image pixels
    keypoints: np.ndarray  # 6 x 2 (right eye, left eye, nose, mouth, right ear, left ear)

    @property
    def size(self) -> float:
        return float(max(self.box[2] - self.box[0], self.box[3] - self.box[1]))


def _anchors() -> np.ndarray:
    # short-range BlazeFace: 128x128 input, 16x16 map with 2 anchors and 8x8 map with 6 anchors
    out = []
    for fm, per_cell in ((16, 2), (8, 6)):
        for y in range(fm):
            for x in range(fm):
                out += [[(x + 0.5) / fm, (y + 0.5) / fm]] * per_cell
    return np.array(out, np.float32)


class FaceLandmarker:
    def __init__(self, threads: int = 2):
        reg = get_registry()
        self.det = ort_session(reg.require(BLAZE_FACE), threads)
        self.mesh = ort_session(reg.require(FACE_MESH), threads)
        self.anchors = _anchors()

    # ---- detection on a square view ----
    def _detect_square(self, rgb_sq: np.ndarray, min_score: float = 0.5) -> list[Detection]:
        side = rgb_sq.shape[0]
        inp = cv2.resize(rgb_sq, (128, 128), interpolation=cv2.INTER_AREA).astype(np.float32) / 127.5 - 1.0
        reg, cls = self.det.run(None, {"input": inp[None]})
        reg, cls = reg[0], cls[0, :, 0]
        score = 1 / (1 + np.exp(-np.clip(cls, -50, 50)))
        keep = np.where(score >= min_score)[0]
        if len(keep) == 0:
            return []
        a = self.anchors[keep]
        r = reg[keep] / 128.0
        cx, cy, w, h = r[:, 0] + a[:, 0], r[:, 1] + a[:, 1], r[:, 2], r[:, 3]
        boxes = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], 1)
        kps = r[:, 4:].reshape(-1, 6, 2) + a[:, None, :]
        sc = score[keep]
        order = list(np.argsort(-sc))
        dets: list[Detection] = []
        while order:                       # weighted NMS: blend overlapping candidates
            i = order[0]
            bi = boxes[i]
            rest = np.array(order)
            x1 = np.maximum(bi[0], boxes[rest, 0])
            y1 = np.maximum(bi[1], boxes[rest, 1])
            x2 = np.minimum(bi[2], boxes[rest, 2])
            y2 = np.minimum(bi[3], boxes[rest, 3])
            inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
            area_i = (bi[2] - bi[0]) * (bi[3] - bi[1])
            area_r = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
            iou = inter / (area_i + area_r - inter + 1e-9)
            grp = rest[iou > 0.3]
            wgt = sc[grp][:, None]
            dets.append(Detection(float(sc[grp].max()), (boxes[grp] * wgt).sum(0) / wgt.sum() * side,
                                  (kps[grp] * wgt[:, :, None]).sum(0) / wgt.sum() * side))
            drop = set(grp.tolist())
            order = [j for j in order if j not in drop]
        return dets

    def detect(self, rgb: np.ndarray) -> list[Detection]:
        """All faces found, largest first. The short-range detector needs the face to be a fair
        share of its input, so progressively tighter square windows are tried."""
        h, w = rgb.shape[:2]
        side = max(h, w)
        windows = [(-(side - w) // 2, -(side - h) // 2, side)]
        s2 = min(h, w)
        windows += [((w - s2) // 2, 0, s2), ((w - s2) // 2, (h - s2) // 2, s2)]
        s3 = int(s2 * 0.6)
        windows += [((w - s3) // 2, int(h * 0.05), s3), ((w - s3) // 2, (h - s3) // 2, s3)]
        for (x0, y0, s) in windows:
            m = np.array([[1, 0, -x0], [0, 1, -y0]], np.float32)
            view = cv2.warpAffine(rgb, m, (s, s), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            dets = self._detect_square(view)
            if dets:
                shift4 = np.array([x0, y0, x0, y0], np.float32)
                shift2 = np.array([x0, y0], np.float32)
                out = [Detection(d.score, d.box + shift4, d.keypoints + shift2) for d in dets]
                return sorted(out, key=lambda d: -d.size * d.score)
        return []

    # ---- mesh on a rotated ROI ----
    def mesh_roi(self, rgb: np.ndarray, cx: float, cy: float, size: float, rot: float) -> tuple[np.ndarray, float]:
        c, s = np.cos(rot), np.sin(rot)
        half = size / 2
        ux, uy = np.array([c, s], np.float32), np.array([-s, c], np.float32)
        ctr = np.array([cx, cy], np.float32)
        src = np.stack([ctr - ux * half - uy * half, ctr + ux * half - uy * half,
                        ctr - ux * half + uy * half]).astype(np.float32)
        dst = np.array([[0, 0], [256, 0], [0, 256]], np.float32)
        m = cv2.getAffineTransform(src, dst)
        roi = cv2.warpAffine(rgb, m, (256, 256), flags=cv2.INTER_LINEAR)
        out = self.mesh.run(None, {"input": (roi.astype(np.float32) / 255.0)[None]})
        pts = out[0].reshape(478, 3).astype(np.float32)
        presence = float(1 / (1 + np.exp(-float(np.ravel(out[1])[0]))))
        k = size / 256.0
        local = (pts[:, :2] - 128.0) * k
        xy = ctr + local[:, :1] * ux + local[:, 1:2] * uy
        return np.concatenate([xy, pts[:, 2:3] * k], 1), presence

    def _refine(self, rgb: np.ndarray, lm: np.ndarray) -> np.ndarray:
        """Second pass with the ROI recomputed from the landmarks (as MediaPipe tracking does)."""
        rot = float(np.arctan2(lm[263, 1] - lm[33, 1], lm[263, 0] - lm[33, 0]))
        c, s = np.cos(rot), np.sin(rot)
        rel = lm[:, :2] @ np.array([[c, -s], [s, c]], np.float32)
        lo, hi = rel.min(0), rel.max(0)
        ctr = ((lo + hi) / 2) @ np.array([[c, s], [-s, c]], np.float32)
        lm2, presence2 = self.mesh_roi(rgb, float(ctr[0]), float(ctr[1]), float((hi - lo).max()) * 1.5, rot)
        return lm2 if presence2 >= 0.5 else lm

    def landmarks_for(self, rgb: np.ndarray, det: Detection) -> np.ndarray | None:
        r_eye, l_eye = det.keypoints[0], det.keypoints[1]   # subject's right eye is on the image's left
        rot = float(np.arctan2(l_eye[1] - r_eye[1], l_eye[0] - r_eye[0]))
        cx, cy = (det.box[0] + det.box[2]) / 2, (det.box[1] + det.box[3]) / 2
        lm, presence = self.mesh_roi(rgb, float(cx), float(cy), det.size * 1.5, rot)
        if presence < 0.5:
            return None
        return self._refine(rgb, lm)

    def landmarks_from_points(self, rgb: np.ndarray, left_eye, right_eye, mouth_left, mouth_right, chin
                              ) -> np.ndarray | None:
        """478 landmarks from five user-marked points (pixels; "left" = image left)."""
        le, re = np.asarray(left_eye, np.float32), np.asarray(right_eye, np.float32)
        ml, mr, ch = (np.asarray(p, np.float32) for p in (mouth_left, mouth_right, chin))
        rot = float(np.arctan2(re[1] - le[1], re[0] - le[0]))
        eye_c, mouth_c = (le + re) / 2, (ml + mr) / 2
        ctr = (eye_c + mouth_c) / 2
        size = max(float(np.linalg.norm(re - le)) * 2.4, float(np.linalg.norm(ch - eye_c)) * 1.9) * 1.5
        lm, presence = self.mesh_roi(rgb, float(ctr[0]), float(ctr[1]), size, rot)
        if presence < 0.5:
            return None
        return self._refine(rgb, lm)

    def landmarks(self, rgb: np.ndarray) -> np.ndarray | None:
        """Landmarks of the most prominent face: (478, 3) in pixels (z in x-pixel units)."""
        dets = self.detect(rgb)
        return self.landmarks_for(rgb, dets[0]) if dets else None


def face_metrics(lm: np.ndarray) -> dict:
    """Scale-free measurements used for retargeting ratios and for objective evaluation."""
    def d(a: int, b: int) -> float:
        return float(np.linalg.norm(lm[a, :2] - lm[b, :2]))

    eye_dist = d(33, 263) + 1e-6
    return {
        "lip_ratio": d(13, 14) / (d(61, 291) + 1e-6),        # inner-lip gap / mouth width
        "mouth_open": d(13, 14) / eye_dist,
        "mouth_width": d(61, 291) / eye_dist,
        "outer_open": d(0, 17) / eye_dist,
        "eye_l": d(159, 145) / (d(33, 133) + 1e-6),
        "eye_r": d(386, 374) / (d(263, 362) + 1e-6),
        "brow": (d(105, 159) + d(334, 386)) / (2 * eye_dist),
    }


_shared: FaceLandmarker | None = None
_shared_lock = threading.Lock()


def get_face_landmarker() -> FaceLandmarker:
    global _shared
    with _shared_lock:
        if _shared is None:
            _shared = FaceLandmarker()
        return _shared
