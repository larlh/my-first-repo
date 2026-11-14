"""Integration (slow): real weights, real frames. Prepares the synthetic fixture portrait and
animates ~1 s with the viseme driver, checking the things that matter to the product:
valid clip + matte, determinism (same seed => same frames), bilabial closure and vowel opening
measured on the rendered pixels, a still background, and generator fidelity vs. the f32 reference.

    pytest -m slow            (about 2-4 minutes on a 4-core CPU)
"""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

pytestmark = pytest.mark.slow
FIXTURE = Path(__file__).parent / "fixtures" / "synthetic_face.jpg"
FPS = 25
SECONDS = 1.0
CUES = [{"tMs": 0, "viseme": "rest"}, {"tMs": 80, "viseme": "A"}, {"tMs": 360, "viseme": "MBP"},
        {"tMs": 480, "viseme": "A"}, {"tMs": 700, "viseme": "U"}, {"tMs": 900, "viseme": "rest"}]


def _read_frames(path: str, gray: bool = False) -> np.ndarray:
    info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                      "stream=width,height", "-of", "json", path],
                                     capture_output=True, text=True, check=True).stdout)["streams"][0]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt",
                          "gray" if gray else "bgr24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, info["height"], info["width"], 1 if gray else 3)


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    import os

    from parlante_engine.core import config
    from parlante_engine.core.registry import get_registry, reset_registry

    work = tmp_path_factory.mktemp("engine-work")
    old = os.environ.get("AVATAR_ENGINE_WORK_DIR")
    os.environ["AVATAR_ENGINE_WORK_DIR"] = str(work)
    config.reset_settings_cache()
    reset_registry()
    reg = get_registry()
    if not (reg.capability_ready("prepare") and reg.capability_ready("animate")):
        pytest.skip("weights not downloaded: run scripts/download_models.py")
    from parlante_engine.animate.service import AnimateJob, run_animation
    from parlante_engine.prepare.service import PrepareJob, run_prepare

    src = work / "in"
    src.mkdir()
    shutil.copyfile(FIXTURE, src / "photo.jpg")
    with wave.open(str(src / "speech.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", int(3000 * np.sin(i / 9.0))) for i in range(int(16000 * SECONDS))))
    prep = run_prepare(PrepareJob(src / "photo.jpg", work / "prep"))
    runs = {}
    for name, frames in (("a", None), ("b", 6), ("c", 6)):      # b and c are the same request twice
        out = work / f"clip_{name}"
        runs[name] = run_animation(AnimateJob(Path(prep["portraitPath"]), Path(prep["maskPath"]), src / "speech.wav",
                                              out, fps=FPS, max_size=512, visemes=CUES, seed=5, max_frames=frames))
    yield {"work": work, "prep": prep, **runs}
    if old is None:
        os.environ.pop("AVATAR_ENGINE_WORK_DIR", None)
    else:
        os.environ["AVATAR_ENGINE_WORK_DIR"] = old
    config.reset_settings_cache()
    reset_registry()


def test_prepare_result(rendered):
    import cv2

    prep = rendered["prep"]
    assert prep["kind"] == "prepare" and prep["landmarksSource"] == "detected"
    portrait = cv2.imread(prep["portraitPath"])
    mask = cv2.imread(prep["maskPath"], cv2.IMREAD_GRAYSCALE)
    assert portrait.shape[:2] == (prep["height"], prep["width"]) == mask.shape
    lm = prep["landmarks"]
    assert lm["leftEye"]["x"] < lm["rightEye"]["x"] and lm["mouthLeft"]["x"] < lm["mouthRight"]["x"]
    assert lm["leftEye"]["y"] < lm["mouthLeft"]["y"] < lm["chin"]["y"]
    # the matte keeps the face and drops the top corners (background)
    cx, cy = int(lm["leftEye"]["x"] * prep["width"]), int(lm["leftEye"]["y"] * prep["height"])
    assert mask[cy, cx] > 240 and mask[4, 4] < 30 and mask[4, -5] < 30
    assert Path(prep["previewPath"]).is_file()


def test_clip_and_matte_are_valid(rendered):
    res = rendered["a"]
    assert res["kind"] == "animate" and res["alpha"] == "mask-video" and res["driver"] == "visemes"
    assert res["frameCount"] == int(FPS * SECONDS)
    frames, matte = _read_frames(res["videoPath"]), _read_frames(res["maskPath"], gray=True)
    assert frames.shape == (res["frameCount"], res["height"], res["width"], 3)
    assert matte.shape[:3] == frames.shape[:3]
    assert matte.max() > 245 and matte.min() < 10              # full range survives the H.264 round trip
    tags = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags=comment", "-of", "json",
                                      res["videoPath"]], capture_output=True, text=True).stdout)
    assert "AI-generated" in tags["format"]["tags"]["comment"]


def test_same_seed_gives_identical_frames(rendered):
    """Same request + seed => the same frames, bit for bit (hash taken before encoding), and
    therefore byte-identical clip and matte files."""
    a, b, c = rendered["a"], rendered["b"], rendered["c"]
    assert a["seed"] == b["seed"] == c["seed"] == 5
    assert b["stats"]["framesSha256"] == c["stats"]["framesSha256"]
    assert Path(b["videoPath"]).read_bytes() == Path(c["videoPath"]).read_bytes()
    assert Path(b["maskPath"]).read_bytes() == Path(c["maskPath"]).read_bytes()
    # the 6-frame clips show the same pictures as the start of the full clip (the H.264 streams
    # differ because the encoder sees a different number of frames, hence the PSNR bound)
    fa, fb = _read_frames(a["videoPath"])[:6].astype(np.float64), _read_frames(b["videoPath"]).astype(np.float64)
    psnr = 10 * np.log10(255.0 ** 2 / max(np.mean((fa - fb) ** 2), 1e-9))
    assert psnr > 38.0, f"same frames expected, PSNR {psnr:.1f} dB"


def test_mouth_follows_the_timeline(rendered):
    import cv2

    from parlante_engine.prepare.face import face_metrics, get_face_landmarker

    frames = _read_frames(rendered["a"]["videoPath"])
    mesh = get_face_landmarker()
    ratio = []
    for f in frames:
        lm = mesh.landmarks(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
        assert lm is not None
        ratio.append(face_metrics(lm)["lip_ratio"])
    ratio = np.array(ratio)
    t = (np.arange(len(ratio)) + 0.5) * 1000 / FPS
    open_a = ratio[(t > 180) & (t < 330)].max()
    closed_p = ratio[(t > 380) & (t < 470)].min()
    assert open_a > 0.25, f"vowel /a/ not open enough: {open_a:.3f}"
    assert closed_p < 0.06, f"bilabial not closed: {closed_p:.3f}"
    assert ratio[0] < 0.08 and ratio[-1] < 0.08, "clip must start and end with the mouth at rest"


def test_background_is_still_and_face_moves(rendered):
    frames = _read_frames(rendered["a"]["videoPath"]).astype(np.float32)
    diff = np.abs(np.diff(frames, axis=0)).mean(axis=(0, 3))
    h, w = diff.shape
    assert diff[: h // 16].mean() < 1.5, "top strip (background / hair top) should be almost still"
    assert diff[int(h * 0.55):int(h * 0.75), int(w * 0.4):int(w * 0.6)].mean() > 1.0, "the mouth region must move"


def test_generator_backend_is_faithful_to_f32_reference(rendered):
    """The fast hybrid backend must agree with plain ONNX Runtime f32 on real tensors."""
    from parlante_engine.animate.generator import Generator
    from parlante_engine.animate.lp import Avatar, avatar_cache_path, file_sha256, get_engine

    engine = get_engine()
    sha = file_sha256(Path(rendered["prep"]["portraitPath"]))
    avatar = Avatar.load(avatar_cache_path(sha), sha)
    assert avatar is not None, "prepare must have cached the avatar"
    x_d = engine.stitch(avatar.x_s, avatar.x_s + engine.lip_delta(avatar.x_s, avatar.lip_ratio, 0.4))
    fast = engine.generator.raw(avatar.f_s, x_d[None], avatar.x_s[None])
    ref = Generator(backend="onnxruntime").raw(avatar.f_s, x_d[None], avatar.x_s[None])
    mse = float(np.mean((fast.astype(np.float64) - ref.astype(np.float64)) ** 2))
    psnr = 99.0 if mse == 0 else 10 * np.log10(1.0 / mse)
    assert psnr > 45.0, f"hybrid backend deviates from the f32 reference: PSNR {psnr:.1f} dB"


# ---------------------------------------------------------------------------------------------
# prepare: validation messages and user landmarks
# ---------------------------------------------------------------------------------------------
def _prepare_error(work, name, image):
    import cv2

    from parlante_engine.core.errors import EngineError
    from parlante_engine.prepare.service import PrepareJob, run_prepare

    path = work / "in" / name
    cv2.imwrite(str(path), image)
    out = work / f"val_{path.stem}"
    out.mkdir(exist_ok=True)
    with pytest.raises(EngineError) as exc:
        run_prepare(PrepareJob(path, out))
    assert exc.value.code in ("UNPROCESSABLE", "UNSUPPORTED_MEDIA_TYPE", "PAYLOAD_TOO_LARGE")
    assert len(exc.value.message) > 20 and exc.value.reason
    return exc.value


def test_prepare_rejects_bad_photos_with_clear_reasons(rendered):
    import cv2

    work = rendered["work"]
    face = cv2.imread(str(FIXTURE))
    two = np.hstack([face, face])
    assert _prepare_error(work, "two_faces.png", two).reason == "multiple_faces"
    landscape = np.full((512, 512, 3), 128, np.uint8)
    landscape[::16] = 90
    assert _prepare_error(work, "no_face.png", landscape).reason == "no_face"
    tiny_face = np.full((600, 600, 3), 200, np.uint8)
    small = cv2.resize(face, (150, 150), interpolation=cv2.INTER_AREA)
    tiny_face[100:250, 225:375] = small
    assert _prepare_error(work, "tiny_face.png", tiny_face).reason in ("face_too_small", "no_face", "face_unclear")
    assert _prepare_error(work, "tiny_image.png", cv2.resize(face, (160, 160))).reason == "image_too_small"
    sideways = cv2.rotate(face, cv2.ROTATE_90_CLOCKWISE)
    assert _prepare_error(work, "sideways.png", sideways).reason in ("head_tilted", "no_face", "face_unclear",
                                                                      "not_frontal")
    bogus = work / "in" / "not_an_image.png"
    bogus.write_bytes(b"GIF89a" + b"\x00" * 64)
    from parlante_engine.core.errors import EngineError
    from parlante_engine.prepare.service import PrepareJob, run_prepare
    with pytest.raises(EngineError) as exc:
        run_prepare(PrepareJob(bogus, work / "val_bogus"))
    assert exc.value.reason == "unsupported_image" and exc.value.status == 415


def test_prepare_straightens_a_tilted_head_and_accepts_user_landmarks(rendered):
    import cv2

    from parlante_engine.prepare.service import PrepareJob, run_prepare

    work = rendered["work"]
    face = cv2.imread(str(FIXTURE))
    big = cv2.copyMakeBorder(face, 200, 200, 200, 200, cv2.BORDER_REFLECT_101)
    rot = cv2.getRotationMatrix2D((456, 456), 12.0, 1.0)                 # head tilted by 12 degrees
    tilted = cv2.warpAffine(big, rot, (912, 912), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
    path = work / "in" / "tilted.png"
    cv2.imwrite(str(path), tilted)
    out = work / "prep_tilted"
    out.mkdir(exist_ok=True)
    res = run_prepare(PrepareJob(path, out))
    lm = res["landmarks"]
    eye_slope = (lm["rightEye"]["y"] - lm["leftEye"]["y"]) / (lm["rightEye"]["x"] - lm["leftEye"]["x"])
    assert abs(np.degrees(np.arctan(eye_slope))) < 3.0, "prepared portrait must be upright"
    assert res["width"] == res["height"] and res["width"] % 2 == 0
    assert 0.3 < lm["leftEye"]["y"] < 0.55, "eyes framed in the upper half"
    # the same photo with the five points marked by the user (taken from the detector, in SOURCE coordinates)
    from parlante_engine.prepare.face import get_face_landmarker
    from parlante_engine.prepare.service import five_points

    src_lm = get_face_landmarker().landmarks(cv2.cvtColor(tilted, cv2.COLOR_BGR2RGB))
    user = five_points(src_lm, tilted.shape[1], tilted.shape[0])
    out2 = work / "prep_user"
    out2.mkdir(exist_ok=True)
    res2 = run_prepare(PrepareJob(path, out2, user))
    assert res2["landmarksSource"] == "user"
    lm2 = res2["landmarks"]
    for key in ("leftEye", "rightEye", "mouthLeft", "mouthRight", "chin"):      # same face, framing within 6 %
        assert abs(lm2[key]["x"] - lm[key]["x"]) < 0.06, key
        assert abs(lm2[key]["y"] - lm[key]["y"]) < 0.06, key
    slope2 = (lm2["rightEye"]["y"] - lm2["leftEye"]["y"]) / (lm2["rightEye"]["x"] - lm2["leftEye"]["x"])
    assert abs(np.degrees(np.arctan(slope2))) < 3.0
    assert Path(res2["maskPath"]).is_file() and Path(res2["previewPath"]).is_file()
