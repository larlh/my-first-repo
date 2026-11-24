"""Audio-driven lips: the pure parts of the driver (no weights, no rendering). The motion the
audio model would produce is injected, so what is tested is what the engine does WITH it:
choice of driver, timing (no drift), closure in pauses and on bilabials, and which parts of the
face the audio is allowed to move."""
from __future__ import annotations

import math

import numpy as np
import pytest

from parlante_engine.animate import drivers as D
from parlante_engine.animate.lp import Avatar
from parlante_engine.animate.service import AUDIO_DRIVER_FREE_MB, resolve_driver
from parlante_engine.core.errors import EngineError

SR = 16000


# --------------------------------------------------------------------------- driver choice
def test_explicit_drivers_are_honoured():
    assert resolve_driver("visemes", True, True) == ("visemes", "requested")
    assert resolve_driver("audio", True, False) == ("audio", "requested")       # the caller is told later (503)
    assert resolve_driver("audio", False, True) == ("audio", "requested")
    with pytest.raises(EngineError) as exc:
        resolve_driver("visemes", False, True)
    assert exc.value.reason == "visemes_required"


def test_requests_without_the_field_keep_the_old_rule():
    # nothing changes for clients that never heard of `driver`, whatever the engine prefers
    for audio_ready in (True, False):
        for auto in ("audio", "visemes"):
            assert resolve_driver(None, True, audio_ready, auto)[0] == "visemes"
            assert resolve_driver(None, False, audio_ready, auto)[0] == "audio"


def test_auto_picks_the_best_available_and_never_fails_for_an_optional_model():
    # both drivers usable: by default the two mouth tracks are compared on the clip itself
    assert resolve_driver("auto", True, True) == ("fit", "compare")
    assert resolve_driver("auto", True, True, "audio") == ("audio", "preferred")
    assert resolve_driver("auto", True, True, "visemes") == ("visemes", "preferred")
    for mode in ("fit", "audio"):
        assert resolve_driver("auto", True, False, mode) == ("visemes", "audio_weights_missing")
        assert resolve_driver("auto", True, True, mode, free_mb=AUDIO_DRIVER_FREE_MB - 1) == ("visemes", "low_memory")
        assert resolve_driver("auto", True, True, mode, free_mb=AUDIO_DRIVER_FREE_MB + 1)[0] == mode
    # no timeline: only the audio model can lip-sync at all ...
    assert resolve_driver("auto", False, False, "visemes") == ("audio", "no_timeline")
    # ... unless there is nothing to lip-sync: a silent clip never needs (or loads) the audio model
    assert resolve_driver("auto", False, False, silent=True) == ("visemes", "silent")
    assert resolve_driver("auto", True, True, silent=True) == ("visemes", "silent")


def test_fit_keeps_the_mouth_track_that_follows_the_sound():
    from parlante_engine.animate import controls as C
    from parlante_engine.animate.service import FIT_MARGIN, loudness_fit, pick_by_fit

    fps = 30
    wav = _speech([(0.3, 0.0), (0.5, 0.5), (0.3, 0.0), (0.6, 0.5), (0.3, 0.0)])
    n = int(len(wav) / SR * fps)
    cues = [{"tMs": 0, "viseme": "rest"}, {"tMs": 300, "viseme": "A"}, {"tMs": 800, "viseme": "rest"},
            {"tMs": 1100, "viseme": "A"}, {"tMs": 1700, "viseme": "rest"}]
    on_time = loudness_fit(C.mouth_tracks(cues, len(wav) / 16.0, fps, n_frames=n)[:, 0], wav, fps)
    late = loudness_fit(C.mouth_tracks([{**c, "tMs": c["tMs"] + 220} for c in cues], len(wav) / 16.0, fps,
                                       n_frames=n)[:, 0], wav, fps)
    assert on_time > 0.9 and late < on_time - 0.3            # a timeline 220 ms late scores much lower
    assert loudness_fit(np.zeros(n), wav, fps) is None        # a track that never moves has no fit
    assert loudness_fit(np.ones(4), wav, fps) is None
    # the timeline is kept only when it is clearly better; ties and unknowns go to the sound
    assert pick_by_fit(0.60, 0.40) == ("visemes", "fit_timeline_follows_sound_better")
    assert pick_by_fit(0.40 + FIT_MARGIN / 2, 0.40)[0] == "audio"
    assert pick_by_fit(0.19, 0.44) == ("audio", "fit_audio_follows_sound_better")
    assert pick_by_fit(None, 0.3) == ("audio", "fit_undefined") and pick_by_fit(0.5, None)[0] == "audio"


def test_health_animation_key_follows_the_settings(work_dir, monkeypatch):
    from parlante_engine.animate import service
    from parlante_engine.core import config

    class Reg:
        ready = True

        def capability_ready(self, cap):
            return self.ready

    reg = Reg()
    monkeypatch.setattr(service, "get_registry", lambda: reg)
    first = service.animation_info()
    assert first["autoDriver"] == "audio" and first["key"].startswith("fit-lips.")      # decided per clip
    monkeypatch.setenv("AVATAR_ENGINE_AUTO_DRIVER", "audio")
    config.reset_settings_cache()
    always = service.animation_info()
    assert always["autoDriver"] == "audio" and always["key"].startswith("audio-lips.")
    assert always["key"] != first["key"]
    monkeypatch.delenv("AVATAR_ENGINE_AUTO_DRIVER")
    config.reset_settings_cache()
    monkeypatch.setenv("AVATAR_ENGINE_AUDIO_LIP_GAIN", "1.25")
    config.reset_settings_cache()
    assert service.animation_info()["key"] != first["key"]           # tuning changes the pixels
    reg.ready = False                                               # audio weights not downloaded
    fallback = service.animation_info()
    assert fallback == {"autoDriver": "visemes", "key": f"visemes.r{service.ANIMATION_REVISION}"}
    monkeypatch.setenv("AVATAR_ENGINE_AUTO_DRIVER", "visemes")
    reg.ready = True
    config.reset_settings_cache()
    assert service.animation_info()["autoDriver"] == "visemes"


# --------------------------------------------------------------------------- timing
def test_motion_is_resampled_by_time_with_no_drift_over_a_long_clip():
    seconds, fps = 60, 30
    k = np.arange(seconds * D.MODEL_FPS)
    centre = (k + 0.5) / D.MODEL_FPS                                # motion vector k covers [k, k+1) / 25 s
    motion = np.zeros((len(k), D.MOTION_DIM), np.float32)
    motion[:, 202] = np.sin(2 * math.pi * 2.0 * centre)             # a 2 Hz "mouth"
    out = D.resample_motion(motion, seconds * fps, fps)
    t = (np.arange(seconds * fps) + 0.5) / fps                      # centre of every output frame
    err = np.abs(out[:, 202] - np.sin(2 * math.pi * 2.0 * t))
    assert err[:90].max() < 0.05 and err[-90:].max() < 0.05         # the same at second 1 and at second 59

    def lag(seg):                                                   # best alignment in frames of a 3 s window
        ref = np.sin(2 * math.pi * 2.0 * t[seg])
        return max(range(-4, 5), key=lambda s: float(np.dot(np.roll(out[seg, 202], -s), ref)))

    assert lag(slice(30, 120)) == 0 and lag(slice(1680, 1770)) == 0


def test_lip_advance_shifts_the_motion_earlier():
    k = np.arange(100)
    motion = np.zeros((100, D.MOTION_DIM), np.float32)
    motion[:, 202] = k                                              # value = its own 25 fps index
    plain = D.resample_motion(motion, 60, 30)[:, 202]
    early = D.resample_motion(motion, 60, 30, advance_ms=40.0)[:, 202]
    assert np.allclose((early - plain)[5:50], 1.0, atol=1e-4)       # 40 ms = one motion frame ahead
    assert plain[0] == pytest.approx(0.0, abs=1e-6) and plain[-1] <= 99.0


# --------------------------------------------------------------------------- closure
def _speech(pattern: list[tuple[float, float]]) -> np.ndarray:
    """[(seconds, amplitude)] -> 16 kHz tone bursts."""
    parts = []
    for seconds, amp in pattern:
        n = int(seconds * SR)
        parts.append((amp * np.sin(2 * math.pi * 180 * np.arange(n) / SR)).astype(np.float32))
    return np.concatenate(parts)


def test_pauses_close_the_lips_completely_and_ramp_in_and_out():
    wav = _speech([(0.3, 0.0), (0.6, 0.5), (0.4, 0.0), (0.5, 0.5), (0.2, 0.0)])
    fps = 30
    n = int(len(wav) / SR * fps)
    close = D.silence_curve(wav, n, fps)
    t = (np.arange(n) + 0.5) / fps
    assert np.all(close[(t > 0.02) & (t < 0.18)] == 1.0)            # lead-in silence
    assert np.all(close[(t > 1.05) & (t < 1.15)] == 1.0)            # the pause between the phrases
    assert np.all(close[(t > 0.45) & (t < 0.75)] == 0.0)            # speaking: the audio decides
    assert np.all(close[-3:] == 1.0)                                # the clip ends at rest
    assert np.abs(np.diff(close)).max() <= 0.34                     # eased over a few frames, never a snap
    # a 60 ms gap inside a phrase (a stop consonant) is not a pause
    stop = _speech([(0.3, 0.5), (0.06, 0.0), (0.3, 0.5)])
    inner = D.silence_curve(stop, int(len(stop) / SR * fps), fps)
    assert inner[8:12].max() == 0.0


def test_bilabials_close_where_the_audio_motion_dips_even_with_a_mistimed_timeline():
    fps = 30
    opening = np.full(60, 0.8, np.float32)
    opening[20] = 0.1                                               # the sound says: lips meet at frame 20
    cues = [{"tMs": 0, "viseme": "A"}, {"tMs": 560, "viseme": "MBP"}, {"tMs": 640, "viseme": "A"},     # ~70 ms early
            {"tMs": 1500, "viseme": "MBP"}, {"tMs": 1560, "viseme": "A"}]                              # no dip there
    w = D.snap_bilabial_closures(opening, cues, fps, 2000.0)
    assert w[20] == 1.0 and w[19] == 0.5 and w[21] == 0.5
    assert w[40:52].max() == 0.0                                    # a cue in the middle of a vowel is ignored
    assert D.snap_bilabial_closures(opening, [{"tMs": 0, "viseme": "A"}], fps, 2000.0).max() == 0.0
    # a timeline known to follow the sound is obeyed: every cue closes, within a frame of its instant
    exact = D.snap_bilabial_closures(opening, cues, fps, 2000.0, trusted=True)
    assert exact[17] == 1.0 and exact[20] == 0.0                    # cue mid at 600 ms: frame 17, not the far dip
    assert exact[44:48].max() == 1.0                                # the second cue closes too (mid 1530 ms)


# --------------------------------------------------------------------------- what the audio may move
class StubEngine:
    """Lip / eye retargeting stand-ins: fixed displacement patterns scaled by the target."""

    def lip_delta(self, x_s, src, tgt):
        d = np.zeros((21, 3), np.float32)
        d[D.KP_LIP, 1] = tgt
        return d

    def eye_delta(self, x_s, left, right, tgt):
        d = np.zeros((21, 3), np.float32)
        d[D.KP_EYE, 1] = 0.02
        return d


def _avatar() -> Avatar:
    rng = np.random.default_rng(3)
    return Avatar(portrait_sha256="0" * 64, width=512, height=512, m_c2o=np.eye(2, 3, dtype=np.float32),
                  f_s=np.zeros((1, 1), np.float32), x_c=(rng.random((21, 3)) - 0.5).astype(np.float32),
                  exp=(rng.random((21, 3)) * 0.01).astype(np.float32), pose_bins=np.zeros((3, 66), np.float32),
                  t=np.zeros(3, np.float32), scale=1.2, lip_ratio=0.02, eye_ratio=np.array([0.3, 0.3], np.float32),
                  eye_open=np.array([0.3, 0.3], np.float32), eye_ball=np.zeros(6, np.float32),
                  landmarks=np.zeros((478, 3), np.float32), calib=np.zeros((0, 2), np.float32))


def _motion(n25: int, lips: float = 0.03, head: float = 0.0) -> np.ndarray:
    """Motion vectors (with the lead-in) whose lips open by `lips` and whose pose logits move."""
    m = np.zeros((n25 + D.LEAD_IN, D.MOTION_DIM), np.float32)
    exp = np.zeros((n25, 21, 3), np.float32)
    exp[:, D.KP_LIP, 1] = lips * (0.5 + 0.5 * np.sin(np.arange(n25) / 2.0))[:, None]
    exp[:, D.KP_EYE, 0] = 0.01                                      # the model also moves the eyes
    m[D.LEAD_IN:, 202:265] = exp.reshape(n25, 63)
    m[D.LEAD_IN:, 1 + 40] = head                                    # a pitch logit: turns the head in "full"
    return m


def _driver(mode: str, wav: np.ndarray, motion: np.ndarray, **kw) -> D.AudioDriver:
    n = int(len(wav) / SR * 30)
    return D.AudioDriver(StubEngine(), _avatar(), wav, 30, 11, n, motion=motion, motion_mode=mode, **kw)


def test_lips_mode_takes_only_the_lips_from_the_audio_and_rests_in_pauses():
    wav = _speech([(0.4, 0.0), (1.0, 0.5), (0.4, 0.0)])
    n25 = int(len(wav) / SR * D.MODEL_FPS) + 1
    calm = _driver("lips", wav, _motion(n25, head=0.0))
    wild = _driver("lips", wav, _motion(n25, head=40.0))            # the model wants to turn the head
    frames = range(calm.n_frames)
    # head pose of the audio model is ignored: identical keypoints
    assert all(np.array_equal(calm.keypoints(f), wild.keypoints(f)) for f in frames)
    full = _driver("full", wav, _motion(n25, head=40.0))
    assert any(not np.allclose(full.keypoints(f), calm.keypoints(f), atol=1e-4) for f in frames)
    # in a pause the lips are exactly where a driver with no lip motion at all puts them
    still = _driver("lips", wav, _motion(n25, lips=0.0))
    lips = [float(np.abs(calm.keypoints(f)[D.KP_LIP] - still.keypoints(f)[D.KP_LIP]).max()) for f in frames]
    t = (np.arange(calm.n_frames) + 0.5) / 30
    assert max(v for v, tt in zip(lips, t) if tt < 0.25 or tt > 1.6) == 0.0
    assert max(v for v, tt in zip(lips, t) if 0.6 < tt < 1.2) > 0.01           # and they do move in speech
    # nothing but the lips differs between the two (eyes, brows and head come from the seeded rig)
    other = [i for i in range(21) if i not in D.KP_LIP]
    assert max(float(np.abs(calm.keypoints(f)[other] - still.keypoints(f)[other]).max()) for f in frames) < 1e-6
    # deterministic, and the gain scales the lip displacement only
    again = _driver("lips", wav, _motion(n25, head=0.0))
    assert all(np.array_equal(calm.keypoints(f), again.keypoints(f)) for f in frames)
    f_mid = max(frames, key=lambda f: float(calm.lip_ratio[f]))
    base = still.keypoints(f_mid)[D.KP_LIP]
    loud = _driver("lips", wav, _motion(n25), lip_gain=1.5)
    assert np.allclose(loud.keypoints(f_mid)[D.KP_LIP] - base, 1.5 * (calm.keypoints(f_mid)[D.KP_LIP] - base),
                       atol=3e-4)                                  # the lip target is quantised to 1/4000
    raw = _driver("lips", wav, _motion(n25), lip_drive="raw")
    raw_loud = _driver("lips", wav, _motion(n25), lip_drive="raw", lip_gain=1.5)
    assert np.allclose(raw_loud.keypoints(f_mid)[D.KP_LIP] - base, 1.5 * (raw.keypoints(f_mid)[D.KP_LIP] - base),
                       atol=1e-5)


def test_opening_goes_through_the_avatar_calibration_and_is_normalised_per_clip():
    wav = _speech([(0.3, 0.0), (1.4, 0.5), (0.3, 0.0)])
    n25 = int(len(wav) / SR * D.MODEL_FPS) + 1
    # the audio model asks two faces for very different openings (0.03 vs 0.012 of displacement) ...
    wide = _driver("lips", wav, _motion(n25, lips=0.03))
    shy = _driver("lips", wav, _motion(n25, lips=0.012))
    assert shy.opening.max() < 0.5 * wide.opening.max()
    # ... each is brought towards clear speech, within the bounds, so the shy one is not left mumbling
    lo, hi = D.ARTICULATION_RANGE
    assert lo <= wide.articulation <= hi and shy.articulation == hi
    speaking = wide.close < 0.5
    assert float(np.percentile(wide.lip_ratio[speaking & (wide.lip_ratio > 0)], 90)) == pytest.approx(
        min(D.ARTICULATION_P90, float(np.percentile(wide.opening[speaking & (wide.opening > 0)], 90))
            * wide._opening_direction()[1] * hi), rel=0.05)
    assert wide.lip_ratio.max() <= D.LIP_RATIO_MAX and wide.lip_ratio[wide.close == 1.0].max() == 0.0
    # a face that only reaches half of what the lip MLP is told gets twice the target
    avatar = _avatar()
    avatar.calib = np.array([[0.0, 0.0], [0.4, 0.2], [0.8, 0.4]], np.float32)
    n = int(len(wav) / SR * 30)
    stiff = D.AudioDriver(StubEngine(), avatar, wav, 30, 11, n, motion=_motion(n25, lips=0.03))
    f = int(np.argmax(wide.lip_ratio))
    assert stiff.lip_ratio[f] == pytest.approx(wide.lip_ratio[f])
    assert stiff.rig.ratio_to_target(float(stiff.lip_ratio[f])) == pytest.approx(2 * float(wide.lip_ratio[f]), rel=1e-3)
    moved = stiff.keypoints(f)[D.KP_LIP, 1] - wide.keypoints(f)[D.KP_LIP, 1]
    assert np.allclose(moved, float(wide.lip_ratio[f]), atol=3e-4)       # StubEngine: displacement = target
    # too little speech to judge: no gain; silence: nothing to scale
    assert D.articulation_gain(np.array([0.05] * 5), np.zeros(5)) == 1.0
    assert D.articulation_gain(np.zeros(40), np.zeros(40)) == 1.0
    assert D.articulation_gain(np.full(40, 0.6), np.zeros(40)) == lo
    assert D.articulation_gain(np.full(40, 0.25), np.zeros(40)) == pytest.approx(1.2)
    with pytest.raises(ValueError):
        _driver("lips", wav, _motion(n25), lip_drive="loose")


def test_rig_blinks_and_head_motion_are_present_in_lips_mode():
    wav = _speech([(0.2, 0.0), (4.6, 0.5), (0.2, 0.0)])
    drv = _driver("lips", wav, _motion(int(len(wav) / SR * D.MODEL_FPS) + 1))
    assert drv.ctl["blink"].max() == 1.0                            # at least one full blink in 5 s
    assert float(np.ptp(drv.ctl["yaw"])) > 0.5                      # degrees of seeded head sway
    assert abs(float(drv.ctl["yaw"][0])) < 0.3 and abs(float(drv.ctl["yaw"][-1])) < 0.3   # cuts cleanly
    with pytest.raises(ValueError):
        _driver("sideways", wav, _motion(10))


# --------------------------------------------------------------------------- GPU probe (stand-in runtime)
def test_cuda_is_only_reported_when_the_provider_really_starts(monkeypatch):
    from parlante_engine.core import backends

    class Session:
        active = ["CPUExecutionProvider"]

        def __init__(self, *_a, **_k):
            pass

        def get_providers(self):
            return self.active

        def run(self, *_a):
            return [np.zeros((1, 4), np.float32)]

    monkeypatch.setattr(backends.ort, "get_available_providers", lambda: ["CPUExecutionProvider"])
    usable, why = backends.probe_cuda()
    assert not usable and "onnxruntime-gpu" in why
    # the GPU wheel is installed but the driver / CUDA libraries are not: ORT falls back silently
    monkeypatch.setattr(backends.ort, "get_available_providers",
                        lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"])
    monkeypatch.setattr(backends.ort, "InferenceSession", Session)
    usable, why = backends.probe_cuda()
    assert not usable and "could not be initialised" in why
    Session.active = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert backends.probe_cuda() == (True, None)


def test_selftest_speech_and_portable_measurements(tmp_path):
    import wave

    from parlante_engine import selftest
    from parlante_engine.core import perf

    wav = tmp_path / "s.wav"
    selftest.synth_speech(wav, 1.0)
    with wave.open(str(wav)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()) == (16000, 1, 2, 16000)
        pcm = np.frombuffer(w.readframes(16000), np.int16)
    assert np.abs(pcm).max() > 4000 and np.abs(pcm[:800]).max() == 0          # voiced, starts in silence
    assert selftest.FACE.is_file()
    assert perf.load_avg() >= 0.0 and perf.peak_rss_mb() > 10 and perf.available_mb() > 0
