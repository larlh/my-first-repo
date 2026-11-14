"""Determinism of the control line: same timeline + seed => identical tracks, bit for bit."""
from __future__ import annotations

import numpy as np

from parlante_engine.animate import controls as C

CUES = [{"tMs": 0, "viseme": "rest"}, {"tMs": 120, "viseme": "O"}, {"tMs": 260, "viseme": "NL"},
        {"tMs": 330, "viseme": "A"}, {"tMs": 480, "viseme": "rest"}, {"tMs": 700, "viseme": "MBP"},
        {"tMs": 760, "viseme": "I"}, {"tMs": 900, "viseme": "E"}, {"tMs": 1080, "viseme": "NL"},
        {"tMs": 1150, "viseme": "FV"}, {"tMs": 1230, "viseme": "E"}, {"tMs": 1400, "viseme": "rest"}]
WORDS = [{"tMs": 120, "durMs": 360, "text": "Hola"}, {"tMs": 700, "durMs": 700, "text": "bienvenidos"}]
DUR = 5200.0


def test_same_input_same_seed_identical():
    a = C.build_controls(CUES, DUR, 30, seed=11, words=WORDS)
    b = C.build_controls([dict(c) for c in CUES], DUR, 30, seed=11, words=[dict(w) for w in WORDS])
    assert C.controls_digest(a) == C.controls_digest(b)
    for key in a:
        assert np.array_equal(a[key], b[key]), key


def test_seed_changes_only_the_seeded_tracks():
    a = C.build_controls(CUES, DUR, 30, seed=1, words=WORDS)
    b = C.build_controls(CUES, DUR, 30, seed=2, words=WORDS)
    assert np.array_equal(a["mouth"], b["mouth"])              # speech never depends on the seed
    assert not np.array_equal(a["yaw"], b["yaw"])
    assert not np.array_equal(a["blink"], b["blink"])


def test_frame_count_covers_the_audio():
    assert C.frame_count(1000, 30) == 30
    assert C.frame_count(1001, 30) == 31
    assert C.frame_count(6579.59, 30) == 198
    assert C.frame_count(0.4, 30) == 1
    ctl = C.build_controls(CUES, DUR, 25, seed=3)
    assert all(len(v) == C.frame_count(DUR, 25) for v in ctl.values())


def test_tracks_are_smooth_bounded_and_start_end_at_rest():
    ctl = C.build_controls(CUES, DUR, 30, seed=5, words=WORDS)
    mouth = ctl["mouth"]
    assert mouth[0, 0] < 0.05 and mouth[-1, 0] < 0.05
    assert abs(ctl["yaw"][0]) < 0.6 and abs(ctl["yaw"][-1]) < 0.6       # clips cut cleanly against the still
    for key, limit in (("pitch", 6.0), ("yaw", 6.0), ("roll", 3.0)):
        assert np.abs(ctl[key]).max() < limit
        assert np.abs(np.diff(ctl[key])).max() < 0.8, key                # degrees per frame: no jumps
    assert 0.0 <= ctl["blink"].min() and ctl["blink"].max() <= 1.0
    assert ctl["blink"].max() == 1.0                                      # at least one full blink in 5 s
    assert mouth[:, 0].max() <= 1.2 and mouth[:, 1].min() >= -1


def test_words_are_derived_when_missing():
    words = C.words_from_cues(CUES, DUR)
    assert words and all(w["durMs"] > 0 for w in words)
    assert words[0]["tMs"] == 120
    a = C.build_controls(CUES, DUR, 30, seed=9)
    b = C.build_controls(CUES, DUR, 30, seed=9, words=words)
    assert C.controls_digest(a) == C.controls_digest(b)


def test_unsorted_cues_are_sorted_and_late_cues_clamped():
    shuffled = list(reversed(CUES)) + [{"tMs": 99999, "viseme": "A"}]
    tr = C.mouth_tracks(shuffled, DUR, 30)
    assert np.isfinite(tr).all() and tr.shape == (C.frame_count(DUR, 30), 4)
