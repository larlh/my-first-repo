"""Automatic quality control of a generated presenter portrait (MediaPipe FaceMesh landmarks).

A portrait passes when it shows exactly one face, frontal, upright, large enough, centred, with
open eyes looking at the camera and the MOUTH CLOSED (the animation engine needs a neutral rest
pose). Every check is a pure function of the landmarks, so it is unit-testable without models.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# MediaPipe FaceMesh indices
FOREHEAD, CHIN, NOSE_TIP = 10, 152, 1
EYE_L_OUT, EYE_L_IN, EYE_R_IN, EYE_R_OUT = 33, 133, 362, 263      # "L" = left side of the IMAGE
LID_L_UP, LID_L_LO, LID_R_UP, LID_R_LO = 159, 145, 386, 374
MOUTH_L, MOUTH_R, LIP_IN_UP, LIP_IN_LO, LIP_OUT_UP, LIP_OUT_LO = 61, 291, 13, 14, 0, 17
CHEEK_L, CHEEK_R = 234, 454
IRIS_L, IRIS_R = 468, 473


@dataclass(frozen=True)
class QcThresholds:
    min_face_height: float = 0.22      # forehead→chin / image height
    max_face_height: float = 0.56      # larger: the top of the head is cut off
    max_roll_deg: float = 10.0         # `prepare` straightens the crop; beyond this the shoulders look wrong
    max_yaw_asym: float = 0.16         # |dl - dr| / (dl + dr), nose tip to cheek edges
    min_pitch_ratio: float = 0.30      # (nose - eyes) / (chin - eyes), frontal ≈ 0.40–0.50
    max_pitch_ratio: float = 0.60
    max_center_offset: float = 0.12    # |face centre x - 0.5| in image widths
    max_mouth_open: float = 0.07       # inner-lip gap / mouth width
    min_eye_open: float = 0.17         # lid gap / eye width
    max_gaze_offset: float = 0.16      # iris centre offset / eye width


@dataclass
class QcReport:
    passed: bool
    issues: list[str]
    face_count: int
    metrics: dict = field(default_factory=dict)
    #: five landmarks normalised 0..1 (PhotoLandmarks of the shared contract) or None
    landmarks5: dict | None = None
    #: 0 = perfect; used to keep the least bad attempt when none passes
    penalty: float = 0.0

    def to_dict(self) -> dict:
        return {"passed": self.passed, "issues": self.issues, "faceCount": self.face_count,
                "metrics": self.metrics, "landmarks": self.landmarks5, "penalty": round(self.penalty, 3)}


def _dist(a, b) -> float:
    return float(np.hypot(a[0] - b[0], a[1] - b[1]))


def face_metrics(lm: np.ndarray, width: int, height: int) -> dict:
    """Geometry of one face from its (478, >=2) landmarks in pixels."""
    p = lm[:, :2].astype(np.float64)
    eye_l = (p[EYE_L_OUT] + p[EYE_L_IN]) / 2
    eye_r = (p[EYE_R_IN] + p[EYE_R_OUT]) / 2
    eyes = (eye_l + eye_r) / 2
    roll = float(np.degrees(np.arctan2(eye_r[1] - eye_l[1], eye_r[0] - eye_l[0])))
    dl, dr = _dist(p[NOSE_TIP], p[CHEEK_L]), _dist(p[NOSE_TIP], p[CHEEK_R])
    mouth_w = _dist(p[MOUTH_L], p[MOUTH_R])
    wl, wr = _dist(p[EYE_L_OUT], p[EYE_L_IN]), _dist(p[EYE_R_IN], p[EYE_R_OUT])
    eye_open = min(_dist(p[LID_L_UP], p[LID_L_LO]) / (wl + 1e-9), _dist(p[LID_R_UP], p[LID_R_LO]) / (wr + 1e-9))
    gaze = 0.0
    if lm.shape[0] > IRIS_R:
        gl = (p[IRIS_L] - eye_l) / (wl + 1e-9)
        gr = (p[IRIS_R] - eye_r) / (wr + 1e-9)
        gaze = float(max(abs(gl[0]), abs(gr[0]), abs((gl[0] + gr[0]) / 2)))
    face_h = _dist(p[FOREHEAD], p[CHIN])
    return {
        "faceHeight": round(face_h / height, 4),
        "rollDeg": round(roll, 2),
        "yawAsym": round((dl - dr) / (dl + dr + 1e-9), 4),
        "pitchRatio": round(float((p[NOSE_TIP][1] - eyes[1]) / (p[CHIN][1] - eyes[1] + 1e-9)), 4),
        "centerOffset": round(float((p[FOREHEAD][0] + p[CHIN][0]) / 2 / width - 0.5), 4),
        "mouthOpen": round(_dist(p[LIP_IN_UP], p[LIP_IN_LO]) / (mouth_w + 1e-9), 4),
        "eyeOpen": round(float(eye_open), 4),
        "gazeOffset": round(gaze, 4),
    }


def landmarks5(lm: np.ndarray, width: int, height: int) -> dict:
    p = lm[:, :2]

    def pt(q):
        return {"x": float(np.clip(q[0] / width, 0, 1)), "y": float(np.clip(q[1] / height, 0, 1))}

    return {"leftEye": pt((p[EYE_L_OUT] + p[EYE_L_IN]) / 2), "rightEye": pt((p[EYE_R_IN] + p[EYE_R_OUT]) / 2),
            "mouthLeft": pt(p[MOUTH_L]), "mouthRight": pt(p[MOUTH_R]), "chin": pt(p[CHIN])}


def evaluate(face_landmarks: list[np.ndarray | None], width: int, height: int,
             th: QcThresholds = QcThresholds()) -> QcReport:
    """`face_landmarks`: one entry per DETECTED face (None when the mesh rejected it)."""
    n = len(face_landmarks)
    if n == 0:
        return QcReport(False, ["no_face"], 0, penalty=100.0)
    if n > 1:
        return QcReport(False, ["multiple_faces"], n, penalty=50.0)
    lm = face_landmarks[0]
    if lm is None:
        return QcReport(False, ["face_not_clear"], 1, penalty=60.0)
    m = face_metrics(lm, width, height)
    issues, pen = [], 0.0

    def check(cond: bool, code: str, excess: float):
        nonlocal pen
        if cond:
            issues.append(code)
            pen += 1.0 + max(0.0, excess)

    check(m["faceHeight"] < th.min_face_height, "face_too_small", (th.min_face_height - m["faceHeight"]) * 20)
    check(m["faceHeight"] > th.max_face_height, "face_too_large", (m["faceHeight"] - th.max_face_height) * 20)
    check(abs(m["rollDeg"]) > th.max_roll_deg, "head_tilted", (abs(m["rollDeg"]) - th.max_roll_deg) / 5)
    check(abs(m["yawAsym"]) > th.max_yaw_asym, "not_frontal", (abs(m["yawAsym"]) - th.max_yaw_asym) * 10)
    check(not (th.min_pitch_ratio <= m["pitchRatio"] <= th.max_pitch_ratio), "head_pitched",
          max(th.min_pitch_ratio - m["pitchRatio"], m["pitchRatio"] - th.max_pitch_ratio) * 10)
    check(abs(m["centerOffset"]) > th.max_center_offset, "off_center", (abs(m["centerOffset"]) - th.max_center_offset) * 10)
    check(m["mouthOpen"] > th.max_mouth_open, "mouth_open", (m["mouthOpen"] - th.max_mouth_open) * 20)
    check(m["eyeOpen"] < th.min_eye_open, "eyes_closed", (th.min_eye_open - m["eyeOpen"]) * 10)
    check(m["gazeOffset"] > th.max_gaze_offset, "not_looking_at_camera", (m["gazeOffset"] - th.max_gaze_offset) * 10)
    return QcReport(not issues, issues, 1, m, landmarks5(lm, width, height), pen)


# ---------------------------------------------------------------- detection glue
def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / (union + 1e-9)


def _contained(a, b) -> float:
    """Share of the smaller box covered by the intersection."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return ix * iy / (small + 1e-9)


def find_faces(rgb: np.ndarray, landmarker, min_score: float = 0.6) -> list:
    """Every face in the image, largest first. BlazeFace (short range) sees a 128-px view, so
    besides the whole image the four quadrant-centred tiles are scanned for small extra faces
    (a second person in the background must fail the check)."""
    h, w = rgb.shape[:2]
    found = [d for d in landmarker.detect(rgb) if d.score >= min_score]
    th, tw = int(h * 0.6), int(w * 0.6)
    for (x0, y0) in ((0, 0), (w - tw, 0), (0, h - th), (w - tw, h - th)):
        tile = np.ascontiguousarray(rgb[y0:y0 + th, x0:x0 + tw])
        for d in landmarker.detect(tile):
            box = d.box + np.array([x0, y0, x0, y0], np.float32)
            # faces cut by the tile border are partial views of a face already seen whole
            margin = 0.02 * max(h, w)
            cut = (x0 > 0 and box[0] - x0 < margin) or (y0 > 0 and box[1] - y0 < margin) or \
                  (x0 + tw < w and x0 + tw - box[2] < margin) or (y0 + th < h and y0 + th - box[3] < margin)
            if d.score < max(min_score, 0.75) or cut:
                continue
            if any(_iou(box, f.box) > 0.2 or _contained(box, f.box) > 0.5 for f in found):
                continue
            found.append(type(d)(d.score, box, d.keypoints + np.array([x0, y0], np.float32)))
    found.sort(key=lambda d: -float(d.box[2] - d.box[0]))
    return found


def check_portrait(rgb: np.ndarray, landmarker=None, thresholds: QcThresholds = QcThresholds()) -> QcReport:
    """Quality control of an RGB uint8 portrait with the engine's face landmarker."""
    if landmarker is None:
        from parlante_engine.prepare.face import get_face_landmarker
        landmarker = get_face_landmarker()
    faces = find_faces(rgb, landmarker)
    meshes = [landmarker.landmarks_for(rgb, d) for d in faces]
    # a detection whose mesh is rejected AND that is tiny is a false positive, not a second person
    if len(faces) > 1:
        main = float(faces[0].box[2] - faces[0].box[0])
        keep = [(f, m) for f, m in zip(faces, meshes)
                if m is not None or float(f.box[2] - f.box[0]) > 0.5 * main]
        meshes = [m for _, m in keep] or meshes[:1]
    return evaluate(meshes, rgb.shape[1], rgb.shape[0], thresholds)
