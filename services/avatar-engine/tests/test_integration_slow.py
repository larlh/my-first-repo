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
    runs = []
    for name in ("a", "b"):
        out = work / f"clip_{name}"
        out.mkdir()
        runs.append(run_animation(AnimateJob(Path(prep["portraitPath"]), Path(prep["maskPath"]), src / "speech.wav",
                                             out, fps=FPS, max_size=512, visemes=CUES, seed=5,
                                             max_frames=None if name == "a" else 6)))
    yield {"work": work, "prep": prep, "a": runs[0], "b": runs[1]}
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
    a, b = _read_frames(rendered["a"]["videoPath"]), _read_frames(rendered["b"]["videoPath"])
    assert rendered["a"]["seed"] == rendered["b"]["seed"] == 5
    # the second run rendered only the first 6 frames: they must match the first run exactly
    # (compared after decoding; the encoder sees identical input, so the bytes are identical too)
    assert np.array_equal(a[:6], b[:6])


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
