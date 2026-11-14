"""Mouth / brow rig for the implicit keypoints.

Maps a Parlante MouthShape (open, width, round, teeth — packages/shared/src/visemes.ts) to
keypoint deltas in the canonical expression space. Mouth OPENING goes through the lip
retargeting MLP (calibrated per avatar); width / rounding / teeth / brows are small linear
bases found empirically with a systematic sweep of every keypoint axis on rendered frames
(R&D prototype A). Each basis entry is (keypoint index, axis, gain)."""
from __future__ import annotations

import numpy as np

RIG = {
    # lip ratio (inner-lip gap / mouth width) commanded for open = 1 and at rest
    "open_ratio_max": 0.46,
    "open_ratio_rest": 0.0,
    "open_gamma": 0.85,
    "wide": [(14, 1, -0.020), (17, 2, 0.007)],                              # lips spread
    # Rounding is deliberately mild: stronger gains purse small mouths into an unnatural pout
    # (seen on the female test portrait); see "Known limits" in the README.
    "narrow": [(20, 2, 0.010), (17, 2, -0.007), (14, 1, 0.009)],            # corners pulled in
    "round": [(20, 2, 0.004), (17, 2, -0.003), (20, 1, 0.0045), (19, 1, 0.003)],  # protrusion
    "teeth": [(20, 1, -0.010)],                                             # upper lip raise
    "brow_up": [(2, 1, -0.022)],
}
BASES = ("wide", "narrow", "round", "teeth", "brow_up")


def _basis(entries) -> np.ndarray:
    d = np.zeros((21, 3), np.float32)
    for k, axis, gain in entries:
        d[int(k), int(axis)] += gain
    return d


class Rig:
    def __init__(self, calib: np.ndarray | None = None, cfg: dict | None = None):
        self.cfg = dict(RIG if cfg is None else cfg)
        self.bases = {name: _basis(self.cfg[name]) for name in BASES}
        self._cal_target: np.ndarray | None = None
        self._cal_achieved: np.ndarray | None = None
        if calib is not None and len(calib) >= 2:
            self.set_open_calibration(calib[:, 0], calib[:, 1])

    def set_open_calibration(self, targets, achieved) -> None:
        """`achieved` lip ratio measured on rendered frames for each lip-MLP `target`. Forced
        monotone so that it can be inverted by interpolation."""
        achieved = np.asarray(achieved, np.float64)
        self._cal_target = np.asarray(targets, np.float64)
        self._cal_achieved = np.maximum.accumulate(achieved + np.arange(len(achieved)) * 1e-6)

    def open_to_ratio(self, open_: float) -> float:
        """MouthShape.open (0..1) -> target ratio for the lip MLP."""
        c = self.cfg
        o = float(np.clip(open_, 0.0, 1.2)) ** c["open_gamma"]
        if o <= 1e-4:
            return float(c["open_ratio_rest"])
        want = c["open_ratio_rest"] + (c["open_ratio_max"] - c["open_ratio_rest"]) * o
        if self._cal_target is None:
            return float(want)
        return float(np.interp(want, self._cal_achieved, self._cal_target))

    def exp_delta(self, open_: float, width: float, round_: float, teeth: float, brow: float = 0.0) -> np.ndarray:
        d = np.zeros((21, 3), np.float32)
        d += max(width, 0.0) * self.bases["wide"]
        # "narrow" and "round" both pull the lips into a pout and add up: they are merged into one
        # bounded amount so that U / O (narrow AND round) do not over-purse small mouths
        pucker = min(0.55, 0.55 * max(-width, 0.0) + 0.25 * round_)
        d += pucker * self.bases["narrow"] + 0.3 * round_ * self.bases["round"]
        # upper teeth only show when the lips are at least slightly apart
        d += teeth * min(1.0, open_ * 4.0) * self.bases["teeth"]
        d += brow * self.bases["brow_up"]
        return d
