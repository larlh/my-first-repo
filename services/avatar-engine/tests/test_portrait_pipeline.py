"""Sampler math and tokenizer of the portrait pipeline. The math needs no weights; the
tokenizer tests need the (1.7 MB) vocabulary files and skip with a reason when missing."""
from __future__ import annotations

import numpy as np
import pytest

from parlante_engine.portrait.pipeline import (alphas_cumprod, dpmpp_2m, karras_sigmas, round_size,
                                                sigma_to_timestep)
from parlante_engine.portrait.service import (SEED_STRIDE, attempt_seed, base_size, estimate_seconds,
                                               estimate_stage_seconds, refine_steps)


def test_schedule_matches_stable_diffusion_1x():
    ac = alphas_cumprod()
    assert ac.shape == (1000,)
    assert ac[0] == pytest.approx(0.99915, abs=1e-5)
    assert ac[-1] == pytest.approx(0.004660, abs=1e-5)
    assert np.all(np.diff(ac) < 0)


def test_karras_sigmas_are_decreasing_and_end_at_zero():
    sig = karras_sigmas(20)
    assert len(sig) == 21 and sig[-1] == 0
    assert np.all(np.diff(sig) < 0)
    assert sig[0] == pytest.approx(14.6146, abs=1e-3)       # sigma of the last training step
    assert sig[-2] == pytest.approx(0.0292, abs=1e-3)       # sigma of the first training step
    assert sigma_to_timestep(sig[0]) == 999 and sigma_to_timestep(sig[-2]) == 0
    ts = [sigma_to_timestep(s) for s in sig[:-1]]
    assert ts == sorted(ts, reverse=True)


def test_dpmpp_2m_recovers_the_clean_signal_of_an_ideal_denoiser():
    """With a denoiser that always returns the true x0, the solver must end exactly at x0."""
    rng = np.random.default_rng(0)
    x0 = rng.standard_normal((1, 4, 8, 8))
    sig = karras_sigmas(12)
    x = x0 + sig[0] * rng.standard_normal(x0.shape)
    calls = []
    out = dpmpp_2m(lambda x, s: x0, x, sig, on_step=lambda i, n: calls.append((i, n)))
    assert np.allclose(out, x0, atol=1e-9)
    assert calls == [(i + 1, 12) for i in range(12)]


def test_dpmpp_2m_converges_for_a_gaussian_prior():
    """Data ~ N(0, 1): the exact denoiser is x / (1 + sigma^2); samples must come out ~N(0, 1)."""
    rng = np.random.default_rng(1)
    sig = karras_sigmas(20)
    x = rng.standard_normal((1, 4, 64, 64)) * np.sqrt(sig[0] ** 2 + 1)
    out = dpmpp_2m(lambda x, s: x / (1 + s ** 2), x, sig)
    assert out.std() == pytest.approx(1.0, abs=0.05)
    assert abs(out.mean()) < 0.05


@pytest.mark.parametrize("value, expected", [(256, 384), (500, 512), (512, 512), (600, 576), (760, 768), (1024, 768)])
def test_sizes_are_rounded_to_what_the_unet_supports(value, expected):
    assert round_size(value, 384, 768) == expected


def test_retry_seeds_are_deterministic_and_distinct():
    assert attempt_seed(7, 0) == 7
    assert attempt_seed(7, 2) == 7 + 2 * SEED_STRIDE
    assert len({attempt_seed(123, k) for k in range(6)}) == 6


def test_composition_size_keeps_the_aspect_ratio_under_512():
    assert base_size(512, 512) == (512, 512) and base_size(384, 448) == (384, 448)
    assert base_size(768, 768) == (512, 512)
    assert base_size(768, 576) == (512, 384)
    assert base_size(576, 768) == (384, 512)
    assert base_size(640, 640) == (512, 512)
    assert refine_steps(20) == 10 and refine_steps(8) == 4


def test_time_estimate_grows_with_resolution_and_steps(work_dir, monkeypatch, tmp_path):
    from parlante_engine.core import config

    monkeypatch.setenv("AVATAR_ENGINE_MODELS_DIR", str(tmp_path / "models"))   # no stored measurements
    config.reset_settings_cache()
    try:
        assert estimate_seconds(768, 768) > 1.3 * estimate_seconds(512, 512)
        assert estimate_seconds(512, 512, steps=30) > estimate_seconds(512, 512, steps=20)
        # the estimate counts the compositions the quality control typically rejects
        assert estimate_seconds(512, 512, attempts=1) < estimate_seconds(512, 512) < estimate_seconds(512, 512, attempts=1) * 2.3
        attempt, refine = estimate_stage_seconds(512, 512)
        assert 20 < attempt < 40 and 10 < refine < 25              # ~26 s + ~17 s on the build machine
        attempt768, refine768 = estimate_stage_seconds(768, 768)
        assert attempt768 == attempt and 40 < refine768 < 80       # same composition, larger second pass
    finally:
        config.reset_settings_cache()


# ---------------------------------------------------------------- tokenizer (needs vocab files)
@pytest.fixture(scope="module")
def tokenizer():
    from parlante_engine.core.registry import get_registry
    from parlante_engine.portrait import models as M
    from parlante_engine.portrait.tokenizer import ClipTokenizer

    reg = get_registry()
    vocab, merges = reg.locate(M.VOCAB), reg.locate(M.MERGES)
    if vocab is None or merges is None:
        pytest.skip("portrait tokenizer files not downloaded (run scripts/download_models.py --all)")
    return ClipTokenizer(vocab, merges)


def test_tokenizer_matches_reference_clip_ids(tokenizer):
    # reference ids produced by transformers.CLIPTokenizer for the same strings
    assert tokenizer.ids("a photo of an astronaut riding a horse on mars") == \
        [320, 1125, 539, 550, 18376, 6765, 320, 4558, 525, 7496]
    assert tokenizer.ids("hello   WORLD it's 1234 naïve café") == \
        [3306, 1002, 585, 568, 272, 273, 274, 275, 1097, 35689, 563, 15304]
    assert tokenizer.ids("señora de 60 años — médica, «sonrisa» 😀 x_y") == \
        [43368, 4301, 654, 277, 271, 41634, 2005, 21890, 1404, 320, 267, 14434, 1176, 553, 1344, 7599, 7334, 343,
         318, 344]


def test_tokenizer_encode_is_one_window_and_truncates(tokenizer):
    one = tokenizer.encode("a portrait")
    assert one.shape == (1, 77) and one.dtype == np.int64
    assert one[0, 0] == 49406 and one[0, 3] == 49407 and one[0, -1] == 49407
    assert tokenizer.encode("").tolist() == [[49406] + [49407] * 76]
    exact = ", ".join(["portrait"] * 38)                 # 38 words + 37 commas = 75 tokens
    assert tokenizer.count(exact) == 75
    assert [int(t) for t in tokenizer.encode(exact)[0, 1:76]] == tokenizer.ids(exact)
    over = tokenizer.encode(exact + ", photo, sharp")
    assert over.shape == (1, 77) and over[0, -1] == 49407       # truncated, EOS kept
    assert [int(t) for t in over[0, 1:76]] == tokenizer.ids(exact)


def test_template_prompts_fit_in_one_window(tokenizer):
    """Every prompt the template can produce must fit in ONE CLIP window with its constraints
    intact (two windows made the model ignore the subject: see tokenizer.py)."""
    import json
    from pathlib import Path

    from parlante_engine.portrait.prompts import (NEGATIVE, STYLES, PortraitSpec, build_prompt,
                                                   prompt_from_description)

    specs = [PortraitSpec(**e["spec"]) for e in
             json.loads((Path(__file__).parents[1] / "stock" / "avatars.json").read_text())["avatars"]]
    specs += [PortraitSpec(gender=g, age=a, skin_tone="brown", heritage="South Asian", style=style,
                           hair="long wavy black hair with a side parting", extra="thin round glasses and small earrings")
              for g in ("female", "male", "neutral") for a in (22, 48, 70) for style in STYLES]
    for spec in specs:
        pair = build_prompt(spec, tokenizer.count)
        assert tokenizer.count(pair.positive) <= 75, pair.positive
        assert tokenizer.count(pair.negative) <= 75, pair.negative
        for phrase in ("front view portrait", "lips closed", "looking into the camera", "head and shoulders",
                       "wall background"):
            assert phrase in pair.positive
        assert NEGATIVE in pair.negative
    long = prompt_from_description("mujer de 40 años con " + ", ".join(["pelo castaño rizado y gafas redondas"] * 20),
                                   None, tokenizer.count)
    assert tokenizer.count(long.positive) <= 75
    for phrase in ("lips closed", "head and shoulders", "wall background", "woman", "40 years old"):
        assert phrase in long.positive


def test_emphasis_scales_only_the_named_tokens_and_keeps_the_mean(tokenizer):
    """Prompt weighting on a stand-in text encoder (identity-like): only the rows of the word
    change relative to the others, and the overall mean is preserved."""
    from parlante_engine.portrait.pipeline import PortraitPipeline

    pipe = PortraitPipeline.__new__(PortraitPipeline)
    pipe.tokenizer = tokenizer
    pipe._text_input = ("input_ids", np.int64)
    rng = np.random.default_rng(0)
    table = rng.standard_normal((49408, 8)).astype(np.float32) + 0.5
    pipe._text_encoder = lambda: (lambda feed: [table[feed["input_ids"][0]][None]])
    text = "portrait of a 40 year old man, short hair, a woman in the background"
    plain = pipe.encode(text)
    weighted = pipe.encode(text, {"man": 1.3})
    assert plain.shape == weighted.shape == (1, 77, 8)
    assert weighted.mean() == pytest.approx(plain.mean(), rel=1e-5)
    ids = [int(t) for t in tokenizer.encode(text)[0]]
    man = tokenizer.ids("man")[0]
    ratio = weighted[0] / plain[0]
    positions = [i for i, t in enumerate(ids) if t == man]
    assert len(positions) == 1                                  # "woman" is a different token
    others = [i for i in range(77) if i not in positions]
    assert np.allclose(ratio[others], ratio[others][0], rtol=1e-4)
    assert np.allclose(ratio[positions] / ratio[others][0], 1.3, rtol=1e-4)
