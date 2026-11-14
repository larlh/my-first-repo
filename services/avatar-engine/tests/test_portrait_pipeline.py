"""Sampler math and tokenizer of the portrait pipeline. The math needs no weights; the
tokenizer tests need the (1.7 MB) vocabulary files and skip with a reason when missing."""
from __future__ import annotations

import numpy as np
import pytest

from parlante_engine.portrait.pipeline import (alphas_cumprod, dpmpp_2m, karras_sigmas, round_size,
                                                sigma_to_timestep)
from parlante_engine.portrait.service import SEED_STRIDE, attempt_seed, estimate_seconds


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


def test_time_estimate_grows_with_resolution_and_steps(work_dir):
    assert estimate_seconds(768, 768) > 2 * estimate_seconds(512, 512)
    assert estimate_seconds(512, 512, steps=30) > estimate_seconds(512, 512, steps=20)


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


def test_tokenizer_windows(tokenizer):
    one = tokenizer.windows("a portrait")
    assert one.shape == (1, 77) and one[0, 0] == 49406 and one[0, 3] == 49407 and one[0, -1] == 49407
    assert tokenizer.windows("").shape == (1, 77)
    comma = tokenizer.ids("a, b")[1]

    def body(row):
        return [int(t) for t in row[1:] if t != 49407]

    # 75 tokens still fit in one window; 76 need two
    exact = ", ".join(["portrait"] * 38)                 # 38 words + 37 commas = 75 tokens
    assert tokenizer.count(exact) == 75 and tokenizer.windows(exact).shape == (1, 77)
    over = exact + ", photo, sharp"                      # 79 tokens
    two = tokenizer.windows(over)
    assert two.shape == (2, 77) and two[0, 0] == 49406 and two[1, 0] == 49406
    first, second = body(two[0]), body(two[1])
    assert first + second == tokenizer.ids(over)         # nothing lost, order kept
    assert abs(len(first) - len(second)) <= 16           # balanced, not 75 + 4
    assert first[-1] == comma                            # cut at a comma, not mid-phrase
    long = tokenizer.windows(", ".join(["studio portrait of a presenter"] * 60))
    assert long.shape == (2, 77)                         # capped at two windows
    assert len(body(long[0])) <= 75 and len(body(long[1])) == 75


def test_template_prompts_fit_in_two_windows(tokenizer):
    from parlante_engine.portrait.prompts import PortraitSpec, build_prompt

    spec = PortraitSpec(gender="female", age=34, skin_tone="brown", heritage="South Asian", hair="long black hair",
                        style="healthcare", extra="thin round glasses and small earrings")
    pair = build_prompt(spec)
    assert tokenizer.count(pair.positive) <= 150
    assert tokenizer.count(pair.negative) <= 150
