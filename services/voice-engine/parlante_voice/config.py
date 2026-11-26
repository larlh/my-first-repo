"""Settings of the voice engine, read from the environment (run.sh loads VOICE_ENGINE_* from .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

SERVICE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = SERVICE_DIR.parent.parent

# Defaults chosen by ear on 2026-11-26 with the person whose voice was cloned ("toma C").
DEFAULT_EXAGGERATION = 0.3
DEFAULT_CFG_WEIGHT = 0.3
DEFAULT_TEMPERATURE = 0.7
DEFAULT_SEED = 7

LANGUAGES = ("es",)


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    return float(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    data_dir: Path
    device: str  # "auto" | "cuda" | "cpu"
    token: str
    exaggeration: float
    cfg_weight: float
    temperature: float

    @property
    def voices_dir(self) -> Path:
        return self.data_dir / "voices"


def load_settings() -> Settings:
    url = urlparse(os.environ.get("VOICE_ENGINE_URL", "http://127.0.0.1:8091"))
    data_dir = Path(os.environ.get("VOICE_ENGINE_DATA_DIR", "") or REPO_DIR / "data" / "voice-engine")
    if not data_dir.is_absolute():
        data_dir = (REPO_DIR / data_dir).resolve()
    return Settings(
        host=os.environ.get("VOICE_ENGINE_HOST", "") or url.hostname or "127.0.0.1",
        port=url.port or 8091,
        data_dir=data_dir,
        device=(os.environ.get("VOICE_ENGINE_DEVICE", "") or "auto").lower(),
        token=os.environ.get("VOICE_ENGINE_TOKEN", ""),
        exaggeration=_float("VOICE_ENGINE_EXAGGERATION", DEFAULT_EXAGGERATION),
        cfg_weight=_float("VOICE_ENGINE_CFG_WEIGHT", DEFAULT_CFG_WEIGHT),
        temperature=_float("VOICE_ENGINE_TEMPERATURE", DEFAULT_TEMPERATURE),
    )
