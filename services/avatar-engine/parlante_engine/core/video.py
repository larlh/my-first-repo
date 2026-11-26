"""ffmpeg helpers: audio probing/decoding and raw-frame H.264 writers. Arguments are always
passed as lists (never through a shell) and file names are engine-generated."""
from __future__ import annotations

import os
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np

from .errors import EngineError

#: Written into every clip (master prompt §2b: AI-generated mark in the MP4 metadata).
AI_METADATA = {
    "comment": "AI-generated content (synthetic talking-head video). Made with Parlante local-neural engine.",
    "description": "AI-generated",
    "encoder": "Parlante avatar-engine",
}


def ffmpeg_bin() -> str:
    exe = os.environ.get("FFMPEG_PATH", "").strip() or "ffmpeg"
    if shutil.which(exe) is None:
        raise EngineError("SERVICE_UNAVAILABLE", "ffmpeg was not found on PATH (set FFMPEG_PATH).", "ffmpeg_missing")
    return exe


def wav_duration_seconds(path: Path) -> float:
    """Duration of a RIFF/WAVE file. The header is checked first (real type, not the extension)."""
    with open(path, "rb") as fh:
        head = fh.read(12)
    if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        raise EngineError("UNSUPPORTED_MEDIA_TYPE", "audioPath must be a WAV file (PCM 16-bit mono).", "not_wav")
    try:
        with wave.open(str(path), "rb") as w:
            frames, rate = w.getnframes(), w.getframerate()
            if rate <= 0:
                raise wave.Error("bad rate")
            return frames / float(rate)
    except (wave.Error, EOFError):
        # non-PCM WAV (float, extensible): let ffmpeg decode it
        return len(decode_audio(path, 16000)) / 16000.0


def decode_audio(path: Path, sample_rate: int = 16000) -> np.ndarray:
    """Any WAV ffmpeg can read -> float32 mono at `sample_rate`."""
    cmd = [ffmpeg_bin(), "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sample_rate),
           "-f", "f32le", "-"]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        raise EngineError("UNPROCESSABLE", "The audio file could not be decoded.", "audio_unreadable")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


class VideoWriter:
    """Pipes raw frames to ffmpeg -> H.264 (yuv420p, +faststart) MP4. `gray=True` for mattes."""

    def __init__(self, path: Path, width: int, height: int, fps: float, gray: bool = False, crf: int = 16,
                 preset: str = "veryfast"):
        if width % 2 or height % 2:
            raise ValueError("H.264 yuv420p needs even dimensions")
        self.path, self.width, self.height, self.gray = Path(path), width, height, gray
        cmd = [ffmpeg_bin(), "-v", "error", "-nostdin", "-y", "-f", "rawvideo",
               "-pix_fmt", "gray" if gray else "bgr24", "-s", f"{width}x{height}", "-r", f"{fps:g}", "-i", "-",
               "-an", "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
               "-movflags", "+faststart"]
        for key, value in AI_METADATA.items():
            cmd += ["-metadata", f"{key}={value}"]
        cmd.append(str(self.path))
        self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        self.frames = 0

    def write(self, frame: np.ndarray) -> None:
        expect = (self.height, self.width) if self.gray else (self.height, self.width, 3)
        if frame.shape != expect or frame.dtype != np.uint8:
            raise ValueError(f"frame shape {frame.shape} / {frame.dtype}, expected {expect} uint8")
        try:
            self._proc.stdin.write(np.ascontiguousarray(frame).tobytes())
        except BrokenPipeError as exc:
            err = self._proc.stderr.read().decode("utf-8", "replace")[-400:]
            raise EngineError("INTERNAL", f"ffmpeg stopped while encoding: {err}") from exc
        self.frames += 1

    def close(self) -> None:
        if self._proc.stdin and not self._proc.stdin.closed:
            self._proc.stdin.close()
        err = self._proc.stderr.read().decode("utf-8", "replace")
        if self._proc.wait() != 0:
            raise EngineError("INTERNAL", f"ffmpeg failed while encoding: {err[-400:]}")

    def abort(self) -> None:
        try:
            if self._proc.stdin and not self._proc.stdin.closed:
                self._proc.stdin.close()
            self._proc.kill()
            self._proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass
        self.path.unlink(missing_ok=True)
