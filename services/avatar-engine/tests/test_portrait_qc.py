"""Quality control of generated portraits: geometry checks on synthetic landmarks (no weights)
and on real test images (needs the 5 MB face models; skipped with a reason when missing)."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from parlante_engine.portrait import qc
from parlante_engine.portrait.qc import QcThresholds, evaluate, face_metrics

FIXTURES = Path(__file__).parent / "fixtures" / "portraits"
W = H = 768


def synthetic_face(cx=384.0, cy=330.0, face_h=250.0, roll_deg=0.0, yaw_shift=0.0, mouth_gap=0.004,
                   eye_open=0.32, gaze=0.0, pitch=0.42) -> np.ndarray:
    """478 landmarks of a schematic frontal face; only the indices the QC reads are meaningful."""
    lm = np.zeros((478, 3), np.float32)
    lm[:, 0], lm[:, 1] = cx, cy
    top, chin = cy - face_h / 2, cy + face_h / 2
    eye_y = top + 0.36 * face_h
    eye_w = 0.17 * face_h
    half_face_w = 0.38 * face_h
    mouth_w = 0.30 * face_h
    mouth_y = top + 0.76 * face_h

    def put(i, x, y):
        lm[i, 0], lm[i, 1] = x, y

    put(qc.FOREHEAD, cx, top)
    put(qc.CHIN, cx, chin)
    put(qc.NOSE_TIP, cx + yaw_shift * half_face_w, eye_y + pitch * (chin - eye_y))
    put(qc.CHEEK_L, cx - half_face_w, eye_y + 0.1 * face_h)
    put(qc.CHEEK_R, cx + half_face_w, eye_y + 0.1 * face_h)
    for (outer, inner, up, lo, iris, side) in ((qc.EYE_L_OUT, qc.EYE_L_IN, qc.LID_L_UP, qc.LID_L_LO, qc.IRIS_L, -1),
                                               (qc.EYE_R_OUT, qc.EYE_R_IN, qc.LID_R_UP, qc.LID_R_LO, qc.IRIS_R, 1)):
        ex = cx + side * 0.19 * face_h
        put(outer, ex + side * eye_w / 2, eye_y)
        put(inner, ex - side * eye_w / 2, eye_y)
        put(up, ex, eye_y - eye_open * eye_w / 2)
        put(lo, ex, eye_y + eye_open * eye_w / 2)
        put(iris, ex + gaze * eye_w, eye_y)
    put(qc.MOUTH_L, cx - mouth_w / 2, mouth_y)
    put(qc.MOUTH_R, cx + mouth_w / 2, mouth_y)
    put(qc.LIP_IN_UP, cx, mouth_y - mouth_gap * mouth_w / 2)
    put(qc.LIP_IN_LO, cx, mouth_y + mouth_gap * mouth_w / 2)
    if roll_deg:
        a = np.radians(roll_deg)
        rot = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]], np.float32)
        lm[:, :2] = (lm[:, :2] - [cx, cy]) @ rot.T + [cx, cy]
    return lm


def test_frontal_closed_mouth_face_passes_and_reports_the_five_landmarks():
    report = evaluate([synthetic_face()], W, H)
    assert report.passed and report.issues == [] and report.face_count == 1
    assert report.penalty == 0
    lm5 = report.landmarks5
    assert set(lm5) == {"leftEye", "rightEye", "mouthLeft", "mouthRight", "chin"}
    assert lm5["leftEye"]["x"] < lm5["rightEye"]["x"]          # "left" = left side of the image
    assert all(0 <= p[k] <= 1 for p in lm5.values() for k in ("x", "y"))


@pytest.mark.parametrize("kwargs, issue", [
    (dict(mouth_gap=0.25), "mouth_open"),
    (dict(roll_deg=14), "head_tilted"),
    (dict(yaw_shift=0.45), "not_frontal"),
    (dict(face_h=110), "face_too_small"),
    (dict(face_h=520, cy=384), "face_too_large"),
    (dict(cx=540), "off_center"),
    (dict(eye_open=0.05), "eyes_closed"),
    (dict(gaze=0.3), "not_looking_at_camera"),
    (dict(pitch=0.75), "head_pitched"),
])
def test_each_defect_is_reported(kwargs, issue):
    report = evaluate([synthetic_face(**kwargs)], W, H)
    assert not report.passed
    assert issue in report.issues
    assert report.penalty >= 1


def test_face_count_rules():
    none = evaluate([], W, H)
    assert not none.passed and none.issues == ["no_face"] and none.face_count == 0
    two = evaluate([synthetic_face(cx=250), synthetic_face(cx=520)], W, H)
    assert not two.passed and two.issues == ["multiple_faces"] and two.face_count == 2
    unclear = evaluate([None], W, H)
    assert not unclear.passed and unclear.issues == ["face_not_clear"]
    # the retry loop keeps the least bad attempt: no face is worse than a tilted head
    assert none.penalty > two.penalty > evaluate([synthetic_face(roll_deg=10)], W, H).penalty


def test_thresholds_are_configurable_and_metrics_are_scale_free():
    face = synthetic_face(mouth_gap=0.05)
    assert evaluate([face], W, H).passed
    assert not evaluate([face], W, H, QcThresholds(max_mouth_open=0.03)).passed
    small = face_metrics(synthetic_face(face_h=200), W, H)
    big = face_metrics(synthetic_face(face_h=300), W, H)
    assert small["mouthOpen"] == pytest.approx(big["mouthOpen"], abs=1e-3)
    assert big["faceHeight"] == pytest.approx(300 / H, abs=1e-3)


# ---------------------------------------------------------------- real images
def _landmarker():
    from parlante_engine.core.registry import get_registry
    from parlante_engine.prepare.models import BLAZE_FACE, FACE_MESH

    reg = get_registry()
    if reg.locate(BLAZE_FACE) is None or reg.locate(FACE_MESH) is None:
        pytest.skip("face models not downloaded (run scripts/download_models.py)")
    from parlante_engine.prepare.face import get_face_landmarker
    return get_face_landmarker()


def _rgb(name: str) -> np.ndarray:
    path = FIXTURES / name
    img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
    assert img is not None, path
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def test_real_frontal_portrait_passes():
    report = qc.check_portrait(_rgb("pass_frontal.jpg"), _landmarker())
    assert report.passed, report.to_dict()
    assert report.metrics["mouthOpen"] < 0.05


@pytest.mark.parametrize("name, issue", [
    ("fail_open_mouth.jpg", "mouth_open"),
    ("fail_tilted.jpg", "head_tilted"),
    ("fail_two_faces.jpg", "multiple_faces"),
    ("fail_no_face.jpg", "no_face"),
])
def test_real_defective_portraits_fail(name, issue):
    report = qc.check_portrait(_rgb(name), _landmarker())
    assert not report.passed
    assert issue in report.issues, report.to_dict()
