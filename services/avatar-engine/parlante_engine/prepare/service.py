"""Prepare job: uploaded photo or generated image -> prepared portrait.

Steps: decode (real type check, size limits) -> face detection -> validation with clear,
translatable reasons -> upright head-and-shoulders framing -> matte -> preview -> appearance
features + canonical keypoints + mouth calibration cached for the animator."""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import EngineError
from parlante_engine.core.jobs import JobContext

from .face import CHIN, L_EYE, MOUTH, R_EYE, get_face_landmarker
from .matte import compute_alpha, matte_source

log = logging.getLogger("parlante.prepare")
MIN_IMAGE_SIDE = 256
MAX_IMAGE_SIDE = 8192
MIN_FACE_SIDE = 110          # pixels of the face box in the source photo
MAX_YAW, MAX_PITCH, MAX_ROLL = 25.0, 25.0, 35.0
FRAME_FACE_RATIO = 2.9       # side of the square crop relative to the face box
MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpeg"), (b"RIFF", "webp"))


@dataclass
class PrepareJob:
    image_path: Path
    output_dir: Path
    landmarks: dict | None = None      # user-marked PhotoLandmarks (normalised to the source image)


def decode_image(path: Path) -> np.ndarray:
    with open(path, "rb") as fh:
        head = fh.read(16)
    kind = next((name for magic, name in MAGIC if head.startswith(magic)), None)
    if kind == "webp" and head[8:12] != b"WEBP":
        kind = None
    if kind is None:
        raise EngineError("UNSUPPORTED_MEDIA_TYPE", "The image must be a PNG, JPEG or WebP file.", "unsupported_image")
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)          # applies EXIF orientation, drops alpha
    if img is None:
        raise EngineError("UNPROCESSABLE", "The image file is damaged and could not be decoded.", "image_unreadable")
    h, w = img.shape[:2]
    if min(h, w) < MIN_IMAGE_SIDE:
        raise EngineError("UNPROCESSABLE", f"The image is too small ({w}x{h}). Use a photo of at least "
                          f"{MIN_IMAGE_SIDE} pixels per side.", "image_too_small")
    if max(h, w) > MAX_IMAGE_SIDE:
        raise EngineError("PAYLOAD_TOO_LARGE", f"The image is too large ({w}x{h}); the limit is "
                          f"{MAX_IMAGE_SIDE} pixels per side.", "image_too_large")
    return img


def five_points(lm: np.ndarray, width: int, height: int) -> dict:
    """PhotoLandmarks (packages/shared entities.ts): normalised 0..1, "left" = image left."""
    def pt(xy) -> dict:
        return {"x": float(np.clip(xy[0] / width, 0, 1)), "y": float(np.clip(xy[1] / height, 0, 1))}

    return {
        "leftEye": pt(lm[[L_EYE[0], L_EYE[1]], :2].mean(0)),
        "rightEye": pt(lm[[R_EYE[0], R_EYE[1]], :2].mean(0)),
        "mouthLeft": pt(lm[MOUTH[0], :2]),
        "mouthRight": pt(lm[MOUTH[1], :2]),
        "chin": pt(lm[CHIN, :2]),
    }


def _detect(rgb: np.ndarray, user: dict | None) -> tuple[np.ndarray, str]:
    h, w = rgb.shape[:2]
    mesh = get_face_landmarker()
    if user:
        px = {k: (float(v["x"]) * w, float(v["y"]) * h) for k, v in user.items()}
        left, right = sorted((px["leftEye"], px["rightEye"]), key=lambda p: p[0])
        mleft, mright = sorted((px["mouthLeft"], px["mouthRight"]), key=lambda p: p[0])
        lm = mesh.landmarks_from_points(rgb, left, right, mleft, mright, px["chin"])
        if lm is None:
            raise EngineError("UNPROCESSABLE", "No face was found at the marked position. Check the landmarks "
                              "or use a clearer, front-facing photo.", "no_face_at_landmarks")
        return lm, "user"
    dets = mesh.detect(rgb)
    if not dets:
        raise EngineError("UNPROCESSABLE", "No face was detected. Use a well-lit photo where the face is "
                          "clearly visible and looks at the camera.", "no_face")
    main = dets[0]
    others = [d for d in dets[1:] if d.score >= 0.6 and d.size >= 0.4 * main.size]
    if others:
        raise EngineError("UNPROCESSABLE", f"{len(others) + 1} faces were detected. Use a photo with exactly "
                          "one person.", "multiple_faces")
    lm = mesh.landmarks_for(rgb, main)
    if lm is None:
        raise EngineError("UNPROCESSABLE", "The face is not clear enough (covered, blurred or cut off). "
                          "Use a sharper, front-facing photo.", "face_unclear")
    return lm, "detected"


def _validate(bgr: np.ndarray, lm: np.ndarray) -> dict:
    from parlante_engine.animate.lp import get_engine

    h, w = bgr.shape[:2]
    mn, mx = lm[:468, :2].min(0), lm[:468, :2].max(0)
    face_side = float(max(mx - mn))
    if face_side < MIN_FACE_SIDE:
        raise EngineError("UNPROCESSABLE", f"The face is too small in the photo ({face_side:.0f} px). It must be "
                          f"at least {MIN_FACE_SIDE} px tall: use a closer or higher-resolution photo.",
                          "face_too_small")
    margin = 0.02 * face_side
    if mn[0] < -margin or mn[1] < -margin or mx[0] > w + margin or mx[1] > h + margin:
        raise EngineError("UNPROCESSABLE", "The face is cut off by the edge of the photo. Use a photo that shows "
                          "the whole face.", "face_cut_off")
    pitch, yaw, roll = get_engine().head_pose(bgr, lm)
    eye_l, eye_r = lm[[33, 133], :2].mean(0), lm[[263, 362], :2].mean(0)
    roll_img = math.degrees(math.atan2(eye_r[1] - eye_l[1], eye_r[0] - eye_l[0]))
    if abs(yaw) > MAX_YAW or abs(pitch) > MAX_PITCH:
        raise EngineError("UNPROCESSABLE", f"The face is not frontal enough (turned {abs(yaw):.0f}°, tilted "
                          f"{abs(pitch):.0f}°). Use a photo looking straight at the camera.", "not_frontal")
    if abs(roll_img) > MAX_ROLL:
        raise EngineError("UNPROCESSABLE", f"The head is tilted too much ({abs(roll_img):.0f}°). Use a photo with "
                          "the head upright.", "head_tilted")
    return {"faceSide": face_side, "pitch": pitch, "yaw": yaw, "roll": roll_img, "box": (mn, mx)}


def _frame(bgr: np.ndarray, lm: np.ndarray, info: dict, max_side: int) -> tuple[np.ndarray, np.ndarray]:
    """Upright, square head-and-shoulders crop. Returns (portrait, 2x3 affine source -> portrait).

    A tilted head (2..35 degrees) is rotated upright about the eye centre. The square is made
    as large as FRAME_FACE_RATIO x face allows; when the (rotated) square does not fit in the
    photo it is shrunk step by step, and only what still falls outside is mirror-filled."""
    h, w = bgr.shape[:2]
    roll = info["roll"]
    eye_c = (lm[[33, 133], :2].mean(0) + lm[[263, 362], :2].mean(0)) / 2
    rot = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    if 2.0 < abs(roll) <= MAX_ROLL:
        rot = cv2.getRotationMatrix2D((float(eye_c[0]), float(eye_c[1])), roll, 1.0)
    pts = lm[:468, :2] @ rot[:, :2].T + rot[:, 2]            # landmarks in the upright frame
    mn, mx = pts.min(0), pts.max(0)
    face = float(max(mx - mn))
    cx = float((mn[0] + mx[0]) / 2)
    inv_rot = cv2.invertAffineTransform(rot)
    best = None
    for shrink in (1.0, 0.93, 0.86, 0.79, 0.72):
        side = max(min(FRAME_FACE_RATIO * face * shrink, float(min(w, h))), min(2.1 * face, float(min(w, h))))
        x0 = cx - side / 2
        y0 = float(eye_c[1]) - 0.42 * side                    # eyes at 42 % of the height
        corners = np.array([[x0, y0], [x0 + side, y0], [x0, y0 + side], [x0 + side, y0 + side]])
        src = corners @ inv_rot[:, :2].T + inv_rot[:, 2]
        overflow = max(0.0, -src[:, 0].min(), -src[:, 1].min(), src[:, 0].max() - w, src[:, 1].max() - h)
        if overflow > 1.0 and abs(roll) <= 2.0:
            # no rotation: simply slide the square back inside the photo
            x0 = float(np.clip(x0, 0, w - side))
            y0 = float(np.clip(y0, 0, h - side))
            overflow = 0.0
        if best is None or overflow < best[0]:
            best = (overflow, side, x0, y0)
        if overflow <= 1.0:
            break
    _, side, x0, y0 = best
    out_side = int(min(max_side, round(side)))
    out_side -= out_side % 2
    k = out_side / side
    crop = np.array([[k, 0, -k * x0], [0, k, -k * y0]], np.float64)
    m = np.concatenate([crop[:, :2] @ rot[:, :2], (crop[:, :2] @ rot[:, 2] + crop[:, 2])[:, None]], 1)
    interp = cv2.INTER_AREA if k < 0.8 else cv2.INTER_LINEAR
    portrait = cv2.warpAffine(bgr, m, (out_side, out_side), flags=interp, borderMode=cv2.BORDER_REFLECT_101)
    return portrait, m


def _preview(portrait: np.ndarray, alpha: np.ndarray | None, size: int = 320) -> np.ndarray:
    """Small JPEG-able preview: the cut-out over a neutral studio gradient (or the plain portrait)."""
    h, w = portrait.shape[:2]
    out = portrait.astype(np.float32)
    if alpha is not None:
        ramp = np.linspace(236, 204, h, dtype=np.float32)[:, None, None] * np.ones((1, w, 3), np.float32)
        out = out * alpha[..., None] + ramp * (1 - alpha[..., None])
    return cv2.resize(out.astype(np.uint8), (size, int(round(size * h / w))), interpolation=cv2.INTER_AREA)


def run_prepare(job: PrepareJob, ctx: JobContext | None = None) -> dict:
    from parlante_engine.animate.lp import avatar_cache_path, file_sha256, get_engine

    def step(frac: float) -> None:
        if ctx:
            ctx.check_canceled()
            ctx.progress(frac, None)

    step(0.02)
    job.output_dir.mkdir(parents=True, exist_ok=True)
    bgr = decode_image(job.image_path)
    lm, source = _detect(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), job.landmarks)
    step(0.15)
    info = _validate(bgr, lm)
    step(0.3)
    portrait, m = _frame(bgr, lm, info, get_settings().portrait_max_side)
    lm_p = lm.copy()
    lm_p[:, :2] = lm[:, :2] @ m[:, :2].T + m[:, 2]
    lm_p[:, 2] = lm[:, 2] * float(np.linalg.norm(m[0, :2]))
    # landmarks re-detected on the final pixels (more accurate after resampling); keep the mapped ones on failure
    refined = get_face_landmarker().landmarks(cv2.cvtColor(portrait, cv2.COLOR_BGR2RGB))
    if refined is not None and np.abs(refined[:468, :2] - lm_p[:468, :2]).mean() < 0.05 * portrait.shape[0]:
        lm_p = refined
    side = portrait.shape[0]
    portrait_path = job.output_dir / "portrait.png"
    mask_path = job.output_dir / "mask.png"
    preview_path = job.output_dir / "preview.jpg"
    if not cv2.imwrite(str(portrait_path), portrait):
        raise EngineError("INTERNAL", "Could not write the prepared portrait.")
    step(0.4)
    alpha = compute_alpha(portrait)
    if alpha is not None:
        cv2.imwrite(str(mask_path), (alpha * 255.0 + 0.5).astype(np.uint8))
    cv2.imwrite(str(preview_path), _preview(portrait, alpha), [cv2.IMWRITE_JPEG_QUALITY, 88])
    step(0.5)
    # appearance + canonical keypoints + mouth calibration, cached for /v1/animations
    sha = file_sha256(portrait_path)

    def on_cal(i: int, n: int) -> None:
        step(0.55 + 0.43 * i / n)

    avatar = get_engine().register(portrait, lm_p, sha, on_cal)
    avatar.save(avatar_cache_path(sha))
    log.info("prepared %s: %dx%d, landmarks %s, matte %s", portrait_path, side, side, source,
             matte_source() if alpha is not None else "none")
    return {
        "kind": "prepare",
        "portraitPath": str(portrait_path),
        "maskPath": str(mask_path) if alpha is not None else None,
        "width": side,
        "height": side,
        "landmarks": five_points(lm_p, side, side),
        "landmarksSource": source,
        "previewPath": str(preview_path),
        "pose": {"pitch": round(info["pitch"], 1), "yaw": round(info["yaw"], 1), "roll": round(info["roll"], 1)},
        "matteModel": matte_source() if alpha is not None else None,
    }
