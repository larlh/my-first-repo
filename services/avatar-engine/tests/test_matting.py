"""Person matting. Unit tests run the public API around a stub network (no weights); the
integration test runs the real model on a synthetic portrait (skips when not downloaded)."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from parlante_engine.core.errors import EngineError
from parlante_engine.matting import api

FIXTURES = Path(__file__).parent / "fixtures" / "portraits"


def synthetic_scene(h=360, w=480):
    """A 'person' (head ellipse + shoulders) of one colour over a contrasting flat background,
    with the exact matte it was drawn from."""
    truth = np.zeros((h, w), np.uint8)
    cv2.ellipse(truth, (w // 2, int(h * 0.36)), (int(w * 0.13), int(h * 0.22)), 0, 0, 360, 255, -1)
    cv2.ellipse(truth, (w // 2, int(h * 1.02)), (int(w * 0.36), int(h * 0.42)), 0, 0, 360, 255, -1)
    truth = cv2.GaussianBlur(truth, (0, 0), 1.5).astype(np.float32) / 255.0
    person = np.zeros((h, w, 3), np.float32) + (60, 90, 170)
    background = np.zeros((h, w, 3), np.float32) + (40, 200, 60)
    image = person * truth[..., None] + background * (1 - truth[..., None])
    return image.astype(np.uint8), truth


class ColourKeyNet:
    """Stand-in for the network: logits from the distance to the (known) background colour,
    computed on the 1024x1024 normalised tensor exactly as the real graph receives it."""

    calls = 0

    def __call__(self, x: np.ndarray) -> np.ndarray:
        ColourKeyNet.calls += 1
        assert x.shape == (1, 3, 1024, 1024) and x.dtype == np.float32
        assert 0.0 <= x.min() and x.max() <= 1.0                      # RGB scaled to 0..1
        rgb = x[0].transpose(1, 2, 0)
        dist = np.linalg.norm(rgb - np.array([60, 200, 40], np.float32) / 255.0, axis=-1)
        return np.clip((dist - 0.2) * 12.0, 0, 1)[None, None].astype(np.float32)


@pytest.fixture()
def stub_model(monkeypatch):
    matter = api.OrmbgMatter.__new__(api.OrmbgMatter)
    matter._run = ColourKeyNet()
    monkeypatch.setattr(api, "_model", matter)
    yield matter
    monkeypatch.setattr(api, "_model", None)


def test_matte_returns_alpha_of_the_image_size(stub_model):
    image, truth = synthetic_scene()
    alpha = api.matte(image)
    assert alpha.shape == image.shape[:2] and alpha.dtype == np.float32
    assert 0.0 <= alpha.min() and alpha.max() <= 1.0
    assert np.abs(alpha - truth).mean() < 0.02                      # follows the drawn matte
    assert alpha[10, 10] < 0.02 and alpha[int(360 * 0.36), 240] > 0.98
    # compositing over a new colour leaves no trace of the old background
    new_bg = np.zeros_like(image, np.float32) + (255, 0, 255)
    comp = image * alpha[..., None] + new_bg * (1 - alpha[..., None])
    assert np.abs(comp[5:40, 5:40] - (255, 0, 255)).max() < 6


def test_matte_accepts_bgra_and_non_square_images(stub_model):
    image, _ = synthetic_scene(300, 200)
    bgra = np.dstack([image, np.full(image.shape[:2], 255, np.uint8)])
    assert api.matte(bgra).shape == (300, 200)
    from parlante_engine import matting
    assert matting.compute_alpha is api.matte                      # the name `prepare` looks up


@pytest.mark.parametrize("bad", [None, np.zeros((10, 10), np.uint8), np.zeros((10, 10, 3), np.float32),
                                 np.zeros((10, 10, 2), np.uint8)])
def test_matte_rejects_invalid_input(stub_model, bad):
    with pytest.raises(EngineError) as err:
        api.matte(bad)
    assert err.value.code == "VALIDATION_ERROR"


def test_refine_edges_removes_haze_and_specks_but_keeps_soft_edges():
    _, truth = synthetic_scene()
    noisy = truth.copy()
    noisy[truth < 0.01] = 0.012                                      # faint haze over the background
    noisy[20:26, 400:406] = 1.0                                      # isolated speck far from the person
    cleaned = api.refine_edges(noisy)
    assert cleaned[5, 5] == 0 and cleaned[22, 402] == 0
    soft = (truth > 0.2) & (truth < 0.8)
    assert soft.sum() > 50 and np.allclose(cleaned[soft], truth[soft])


def test_matte_reports_missing_weights(work_dir, monkeypatch, tmp_path):
    from parlante_engine.core import config, registry

    monkeypatch.setenv("AVATAR_ENGINE_MODELS_DIR", str(tmp_path / "no-models"))
    monkeypatch.delenv("HF_HOME", raising=False)
    monkeypatch.delenv("AVATAR_ENGINE_MODEL_SEARCH_DIRS", raising=False)
    config.reset_settings_cache()
    registry.reset_registry()
    monkeypatch.setattr(api, "_model", None)
    try:
        assert api.available() is False
        with pytest.raises(EngineError) as err:
            api.matte(np.zeros((64, 64, 3), np.uint8))
        assert err.value.code == "SERVICE_UNAVAILABLE"
    finally:
        config.reset_settings_cache()
        registry.reset_registry()


def test_real_model_on_a_synthetic_person():
    """Real weights: a generated (synthetic) presenter re-composited over a saturated colour.
    The matte must keep the person and drop the background."""
    if not api.available():
        pytest.skip("matting weights not downloaded (run scripts/download_models.py)")
    path = FIXTURES / "pass_frontal.jpg"
    image = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
    alpha = api.matte(image)
    h, w = alpha.shape
    assert alpha.shape == image.shape[:2]
    assert alpha[int(h * 0.42), w // 2] > 0.95                      # face
    assert alpha[h - 5, w // 2] > 0.95                              # chest
    assert alpha[8, 8] < 0.05 and alpha[8, w - 8] < 0.05            # top corners are background
    assert 0.25 < float(alpha.mean()) < 0.8
    edge = ((alpha > 0.05) & (alpha < 0.95)).mean()
    assert 0.001 < edge < 0.2                                       # soft edge exists but is thin
    api.release()
