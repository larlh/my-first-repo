"""Configuration from environment variables (documented in the repo's .env.example and in
services/avatar-engine/README.md). Nothing here reads files other than the directories named."""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

SERVICE_DIR = Path(__file__).resolve().parents[2]


def find_repo_root() -> Path:
    """Directory holding pnpm-workspace.yaml (same rule as packages/providers), else the
    service directory (stand-alone / Docker installs)."""
    for parent in SERVICE_DIR.parents:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    return SERVICE_DIR


def _resolve_dir(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = find_repo_root() / path
    return Path(os.path.abspath(path))


def _int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(lo, min(hi, int(raw)))
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _float(name: str, default: float, lo: float, hi: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(lo, min(hi, float(raw)))
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc


def _choice(name: str, default: str, allowed: tuple[str, ...]) -> str:
    raw = os.environ.get(name, "").strip().lower() or default
    if raw not in allowed:
        raise ValueError(f"{name} must be one of {allowed}, got {raw!r}")
    return raw


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    work_dir: Path
    models_dir: Path
    #: Extra read-only places where already downloaded weights may live (Hugging Face caches).
    model_search_dirs: tuple[Path, ...]
    threads: int
    backend: str        # auto | openvino | onnxruntime
    device: str         # auto | cpu | gpu
    precision: str      # auto | f32 | bf16   (OpenVINO inference precision on CPU)
    max_image_mb: int
    max_audio_mb: int
    max_clip_seconds: int
    portrait_max_side: int
    job_ttl_seconds: int
    startup_benchmark: bool
    #: Unsharp-mask amount applied to generated crops (the decoder is softer than the photo).
    sharpen: float
    #: Bearer token; mandatory when the server listens on a non-loopback interface.
    token: str | None


def load_settings() -> Settings:
    url = urlparse(os.environ.get("AVATAR_ENGINE_URL", "").strip() or "http://127.0.0.1:8090")
    # Loopback unless AVATAR_ENGINE_HOST says otherwise (Docker sets 0.0.0.0 inside the container).
    host = os.environ.get("AVATAR_ENGINE_HOST", "").strip() or "127.0.0.1"
    port = _int("AVATAR_ENGINE_PORT", url.port or 8090, 1, 65535)
    cpus = os.cpu_count() or 4
    search = [Path(p) for p in os.environ.get("AVATAR_ENGINE_MODEL_SEARCH_DIRS", "").split(os.pathsep) if p]
    if os.environ.get("HF_HOME"):
        search.append(Path(os.environ["HF_HOME"]))
    return Settings(
        host=host,
        port=port,
        work_dir=_resolve_dir(os.environ.get("AVATAR_ENGINE_WORK_DIR", "").strip() or "./data/avatar-engine"),
        models_dir=_resolve_dir(os.environ.get("AVATAR_ENGINE_MODELS_DIR", "").strip() or "./data/models"),
        model_search_dirs=tuple(search),
        threads=_int("AVATAR_ENGINE_THREADS", min(cpus, 8), 1, 64),
        backend=_choice("AVATAR_ENGINE_BACKEND", "auto", ("auto", "openvino", "onnxruntime")),
        device=_choice("AVATAR_ENGINE_DEVICE", "auto", ("auto", "cpu", "gpu")),
        precision=_choice("AVATAR_ENGINE_PRECISION", "auto", ("auto", "f32", "bf16")),
        max_image_mb=_int("AVATAR_ENGINE_MAX_IMAGE_MB", 25, 1, 200),
        max_audio_mb=_int("AVATAR_ENGINE_MAX_AUDIO_MB", 200, 1, 2000),
        max_clip_seconds=_int("AVATAR_ENGINE_MAX_CLIP_SECONDS", 600, 1, 3600),
        portrait_max_side=_int("AVATAR_ENGINE_PORTRAIT_MAX_SIDE", 768, 256, 1024),
        job_ttl_seconds=_int("AVATAR_ENGINE_JOB_TTL_SECONDS", 3600, 60, 86400),
        sharpen=_float("AVATAR_ENGINE_SHARPEN", 0.6, 0.0, 1.5),
        token=os.environ.get("AVATAR_ENGINE_TOKEN", "").strip() or None,
        startup_benchmark=os.environ.get("AVATAR_ENGINE_STARTUP_BENCHMARK", "1").strip() not in ("0", "false", "no"),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = load_settings()
    settings.work_dir.mkdir(parents=True, exist_ok=True)
    settings.models_dir.mkdir(parents=True, exist_ok=True)
    return settings


def reset_settings_cache() -> None:
    """For tests that change the environment."""
    get_settings.cache_clear()
