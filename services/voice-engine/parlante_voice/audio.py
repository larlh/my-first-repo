"""WAV encoding / decoding and silence trimming (numpy only, no model imports)."""

from __future__ import annotations

import io
import wave

import numpy as np


def decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    """PCM 16-bit WAV (mono or stereo) → float32 mono in [-1, 1] and its sample rate."""
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getsampwidth() != 2:
                raise ValueError("only 16-bit PCM WAV is accepted")
            rate = wav.getframerate()
            channels = wav.getnchannels()
            frames = wav.readframes(wav.getnframes())
    except wave.Error as err:
        raise ValueError(f"not a WAV file: {err}") from err
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def encode_wav(samples: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


def speech_bounds(samples: np.ndarray, rate: int, frame_ms: int = 20) -> tuple[int, int]:
    """First and last sample of speech: frames whose RMS is within 40 dB of the loudest frame."""
    frame = max(1, rate * frame_ms // 1000)
    count = len(samples) // frame
    if count == 0:
        return 0, len(samples)
    rms = np.sqrt(np.mean(samples[: count * frame].reshape(count, frame) ** 2, axis=1) + 1e-12)
    voiced = np.nonzero(rms > rms.max() * 0.01)[0]
    if len(voiced) == 0:
        return 0, 0
    return int(voiced[0] * frame), int(min(len(samples), (voiced[-1] + 1) * frame))


def trim(samples: np.ndarray, rate: int, pad_ms: int = 60) -> np.ndarray:
    start, end = speech_bounds(samples, rate)
    pad = rate * pad_ms // 1000
    return samples[max(0, start - pad) : min(len(samples), end + pad)]


def silence(rate: int, ms: int) -> np.ndarray:
    return np.zeros(rate * ms // 1000, dtype=np.float32)
