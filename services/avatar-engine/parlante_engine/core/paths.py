"""Path validation: every file the HTTP API touches must live inside AVATAR_ENGINE_WORK_DIR.

Requests carry paths (files are exchanged by path with the Node worker). They are untrusted:
a path is accepted only if, after resolving symlinks, it is inside the resolved work dir."""
from __future__ import annotations

import os
from pathlib import Path

from .config import get_settings
from .errors import EngineError


def _work_root() -> Path:
    return Path(os.path.realpath(get_settings().work_dir))


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_in_work_dir(raw: str, field: str = "path") -> Path:
    """Absolute, symlink-resolved path guaranteed to be inside the work dir (may not exist).
    Relative paths are interpreted relative to the work dir."""
    if not isinstance(raw, str) or not raw or "\x00" in raw or len(raw) > 4096:
        raise EngineError("VALIDATION_ERROR", f"{field}: invalid path", "invalid_path")
    root = _work_root()
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = Path(os.path.realpath(candidate))
    if resolved == root or not _inside(resolved, root):
        raise EngineError("VALIDATION_ERROR", f"{field}: path is outside the engine work directory",
                          "path_outside_work_dir")
    return resolved


def resolve_input_file(raw: str, field: str, max_bytes: int | None = None) -> Path:
    """Existing regular file inside the work dir, optionally size-limited."""
    path = resolve_in_work_dir(raw, field)
    if not path.is_file():
        raise EngineError("VALIDATION_ERROR", f"{field}: file not found", "file_not_found")
    if max_bytes is not None and path.stat().st_size > max_bytes:
        raise EngineError("PAYLOAD_TOO_LARGE",
                          f"{field}: file is larger than {max_bytes // (1024 * 1024)} MB", "file_too_large")
    return path


def resolve_output_dir(raw: str, field: str = "outputDir") -> Path:
    """Directory inside the work dir, created if missing."""
    path = resolve_in_work_dir(raw, field)
    if path.exists() and not path.is_dir():
        raise EngineError("VALIDATION_ERROR", f"{field}: not a directory", "not_a_directory")
    path.mkdir(parents=True, exist_ok=True)
    # mkdir may have followed a symlink created meanwhile: re-check after creation
    if not _inside(Path(os.path.realpath(path)), _work_root()):
        raise EngineError("VALIDATION_ERROR", f"{field}: path is outside the engine work directory",
                          "path_outside_work_dir")
    return path
