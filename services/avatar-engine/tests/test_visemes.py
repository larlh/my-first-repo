"""Viseme mapping: the engine's table must equal packages/shared/src/visemes.ts, and every
viseme must map to a distinct, sane control vector and rig delta."""
from __future__ import annotations

import re

import numpy as np
import pytest

from parlante_engine.animate import controls as C
from parlante_engine.animate.rig import Rig


def _parse_ts(repo_root):
    src = (repo_root / "packages/shared/src/visemes.ts").read_text()
    order = re.search(r"export const VISEMES = \[(.*?)\] as const", src, re.S).group(1)
    visemes = tuple(re.findall(r"'([A-Za-z]+)'", order))
    body = re.search(r"VISEME_MOUTH_SHAPES[^=]*=\s*\{(.*?)\n\};", src, re.S).group(1)
    shapes = {}
    for name, fields in re.findall(r"(\w+):\s*\{([^}]*)\}", body):
        vals = dict(re.findall(r"(\w+):\s*(-?[\d.]+)", fields))
        shapes[name] = tuple(float(vals[k]) for k in ("open", "width", "round", "teeth", "tongue"))
    return visemes, shapes


def test_table_matches_shared_typescript(repo_root):
    if repo_root is None:
        pytest.skip("not inside the Parlante monorepo")
    visemes, shapes = _parse_ts(repo_root)
    assert C.VISEMES == visemes
    assert set(C.MOUTH_SHAPES) == set(visemes)
    for name in visemes:
        assert C.MOUTH_SHAPES[name] == pytest.approx(shapes[name]), name


def test_every_viseme_has_dominance_and_is_a_valid_cue():
    assert set(C.DOMINANCE) == set(C.VISEMES)
    for v in C.VISEMES:
        tracks = C.mouth_tracks([{"tMs": 0, "viseme": "rest"}, {"tMs": 200, "viseme": v},
                                 {"tMs": 500, "viseme": "rest"}], 800, 30)
        assert tracks.shape == (24, 4)
        assert np.isfinite(tracks).all()


def test_unknown_viseme_rejected():
    with pytest.raises(ValueError):
        C.mouth_tracks([{"tMs": 0, "viseme": "XX"}], 500, 30)


def _held(viseme: str) -> np.ndarray:
    """Mouth controls in the middle of a long, isolated cue."""
    tr = C.mouth_tracks([{"tMs": 0, "viseme": "rest"}, {"tMs": 300, "viseme": viseme},
                         {"tMs": 900, "viseme": "rest"}], 1200, 50)
    return tr[30]      # t = 610 ms


def test_held_viseme_reaches_its_shape():
    for v in C.VISEMES:
        want = np.array(C.MOUTH_SHAPES[v][:4]) * C.CHANNEL_GAIN
        assert _held(v) == pytest.approx(want, abs=0.02), v


def test_articulation_ordering():
    opening = {v: _held(v)[0] for v in C.VISEMES}
    assert opening["A"] > opening["O"] > opening["E"] > opening["I"] > opening["MBP"]
    assert opening["MBP"] == pytest.approx(0.0, abs=1e-6)
    assert opening["rest"] == pytest.approx(0.0, abs=1e-6)
    width = {v: _held(v)[1] for v in C.VISEMES}
    assert width["I"] > width["E"] > 0 > width["O"] > width["U"]


def test_bilabial_closes_even_between_open_vowels_at_any_fps():
    cues = [{"tMs": 0, "viseme": "rest"}, {"tMs": 100, "viseme": "A"}, {"tMs": 300, "viseme": "MBP"},
            {"tMs": 345, "viseme": "A"}, {"tMs": 600, "viseme": "rest"}]       # a 45 ms /p/
    for fps in (15, 25, 30, 60):
        tr = C.mouth_tracks(cues, 800, fps)
        t = (np.arange(len(tr)) + 0.5) * 1000 / fps
        near = np.abs(t - 322.5) <= 500 / fps + 1e-6
        assert tr[near, 0].min() == pytest.approx(0.0, abs=1e-6), fps
        assert tr[:, 0].max() > 0.8, fps                                      # and the vowels still open


def test_coarticulation_weak_consonant_inherits_from_vowels():
    between_a = C.mouth_tracks([{"tMs": 0, "viseme": "A"}, {"tMs": 300, "viseme": "KG"},
                                {"tMs": 600, "viseme": "A"}], 900, 50)[22]
    between_u = C.mouth_tracks([{"tMs": 0, "viseme": "U"}, {"tMs": 300, "viseme": "KG"},
                                {"tMs": 600, "viseme": "U"}], 900, 50)[22]
    assert between_a[0] > between_u[0]          # more open next to /a/
    assert between_u[2] > between_a[2] + 0.3    # rounded next to /u/


def test_rig_deltas_are_distinct_and_bounded():
    rig = Rig()
    seen = []
    for v in C.VISEMES:
        o, w, r, te = (float(x) for x in np.array(C.MOUTH_SHAPES[v][:4]) * C.CHANNEL_GAIN)
        d = rig.exp_delta(o, w, r, te)
        assert d.shape == (21, 3) and np.abs(d).max() < 0.05
        seen.append((round(rig.open_to_ratio(o), 4), tuple(np.round(d.ravel(), 5))))
    assert len(set(seen)) >= len(C.VISEMES) - 1        # rest and MBP may coincide; all others differ
    assert rig.open_to_ratio(0.0) == 0.0
    assert rig.open_to_ratio(1.0) > rig.open_to_ratio(0.5) > rig.open_to_ratio(0.1) > 0


def test_rig_calibration_is_monotone():
    calib = np.array([[0.0, 0.01], [0.1, 0.02], [0.2, 0.09], [0.3, 0.2], [0.45, 0.19], [0.6, 0.4], [0.8, 0.55]])
    rig = Rig(calib)
    ratios = [rig.open_to_ratio(o) for o in np.linspace(0.01, 1, 40)]
    assert all(b >= a - 1e-9 for a, b in zip(ratios, ratios[1:]))
    assert 0 <= min(ratios) and max(ratios) <= 0.8
