"""Model registry: every weight file the engine may load, where it comes from, its checksum
and its licence. Weights are data-only formats (ONNX, MediaPipe .tflite/.task, safetensors);
pickle-based formats are refused by construction.

Each sub-package declares its files in `<sub>/models.py` as `MODELS: list[ModelFile]`; the
registry aggregates them, locates verified copies on disk and downloads missing ones.

Disk layout (inside AVATAR_ENGINE_MODELS_DIR):
    <org>--<name>/<revision>/<filename>      files from huggingface.co
    mediapipe/<basename>                     files from storage.googleapis.com/mediapipe-models
    derived/…                                files the engine derives itself (graph splits)
    .verified.json                           cache of verified checksums (path, size, mtime)
Already populated Hugging Face caches (HF_HOME, AVATAR_ENGINE_MODEL_SEARCH_DIRS) are reused
in place when the checksum matches, so nothing is downloaded twice.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlparse

from .config import get_settings
from .errors import EngineError

SUBPACKAGES = ("prepare", "animate", "matting", "portrait")
ROLES = ("portrait-generation", "face-detection", "matting", "animation", "other")
#: Capabilities reported by /health (contract) plus the optional audio driver.
CAPABILITIES = ("generate", "prepare", "animate", "animate-audio")
SAFE_SUFFIXES = (".onnx", ".onnx_data", ".safetensors", ".tflite", ".task", ".json", ".txt", ".bin.safetensors")
ALLOWED_URL_PREFIXES = ("https://storage.googleapis.com/mediapipe-models/",)
HF_ENDPOINT = "https://huggingface.co"


@dataclass(frozen=True)
class ModelFile:
    """One weight file. `model_id` groups the files of a model and is the id used in
    docs/MODELS.md and in GET /health."""

    model_id: str
    role: str
    #: Which capabilities need this file: any of CAPABILITIES.
    capabilities: tuple[str, ...]
    filename: str
    sha256: str
    size: int
    license: str
    commercial_use: bool
    repo: str | None = None
    revision: str | None = None
    url: str | None = None
    description: str = ""

    def __post_init__(self) -> None:
        if self.role not in ROLES:
            raise ValueError(f"{self.model_id}: unknown role {self.role}")
        if not set(self.capabilities) <= set(CAPABILITIES):
            raise ValueError(f"{self.model_id}: unknown capability in {self.capabilities}")
        if not self.filename.endswith(SAFE_SUFFIXES):
            raise ValueError(f"{self.model_id}: {self.filename} is not a data-only weight format")
        if ".." in Path(self.filename).parts or self.filename.startswith("/"):
            raise ValueError(f"{self.model_id}: unsafe filename {self.filename}")
        if bool(self.repo) == bool(self.url):
            raise ValueError(f"{self.model_id}: give exactly one of repo or url")
        if self.repo and not self.revision:
            raise ValueError(f"{self.model_id}: Hugging Face files need a pinned revision")
        if self.url and not self.url.startswith(ALLOWED_URL_PREFIXES):
            raise ValueError(f"{self.model_id}: url host not allowed: {self.url}")
        if len(self.sha256) != 64:
            raise ValueError(f"{self.model_id}: sha256 must be 64 hex chars")

    @property
    def key(self) -> str:
        return f"{self.repo}@{self.revision}/{self.filename}" if self.repo else str(self.url)

    @property
    def source_url(self) -> str:
        if self.repo:
            return f"{HF_ENDPOINT}/{self.repo}/resolve/{self.revision}/{self.filename}"
        return str(self.url)

    @property
    def relative_path(self) -> Path:
        if self.repo:
            return Path(self.repo.replace("/", "--")) / str(self.revision) / self.filename
        return Path("mediapipe") / Path(urlparse(str(self.url)).path).name


def sha256_file(path: Path, on_bytes: Callable[[int], None] | None = None) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
            if on_bytes:
                on_bytes(len(block))
    return digest.hexdigest()


class Registry:
    def __init__(self, files: Iterable[ModelFile], models_dir: Path, search_dirs: Iterable[Path] = ()):
        self.files: list[ModelFile] = []
        seen: dict[str, ModelFile] = {}
        for f in files:
            if f.key in seen:
                if seen[f.key].sha256 != f.sha256:
                    raise ValueError(f"conflicting declarations for {f.key}")
                continue
            seen[f.key] = f
            self.files.append(f)
        self.models_dir = Path(models_dir)
        self.search_dirs = tuple(Path(p) for p in search_dirs)
        self._lock = threading.Lock()
        self._verified_path = self.models_dir / ".verified.json"
        self._verified: dict[str, dict] = {}
        try:
            self._verified = json.loads(self._verified_path.read_text())
        except (OSError, ValueError):
            self._verified = {}

    # ---------- locating ----------
    def _candidates(self, f: ModelFile) -> list[Path]:
        out = [self.models_dir / f.relative_path]
        for base in (self.models_dir, *self.search_dirs):
            if f.repo:
                out.append(base / "hub" / ("models--" + f.repo.replace("/", "--")) / "snapshots"
                           / str(f.revision) / f.filename)
            else:
                out.append(base / f.relative_path)
        return out

    def _is_verified(self, path: Path, f: ModelFile) -> bool:
        try:
            real = Path(os.path.realpath(path))
            st = real.stat()
        except OSError:
            return False
        if st.st_size != f.size:
            return False
        rec = self._verified.get(str(real))
        if rec and rec.get("size") == st.st_size and rec.get("mtime_ns") == st.st_mtime_ns:
            return rec.get("sha256") == f.sha256
        actual = sha256_file(real)
        with self._lock:
            self._verified[str(real)] = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "sha256": actual}
            self._save_verified()
        return actual == f.sha256

    def _save_verified(self) -> None:
        try:
            self.models_dir.mkdir(parents=True, exist_ok=True)
            tmp = self._verified_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._verified, indent=1))
            os.replace(tmp, self._verified_path)
        except OSError:
            pass

    def locate(self, f: ModelFile) -> Path | None:
        """Path of a checksum-verified copy, or None."""
        for cand in self._candidates(f):
            if cand.is_file() and self._is_verified(cand, f):
                return cand
        return None

    def require(self, f: ModelFile) -> Path:
        path = self.locate(f)
        if path is None:
            raise EngineError(
                "SERVICE_UNAVAILABLE",
                f"Model weights missing: {f.model_id} ({f.filename}). "
                "Run `python scripts/download_models.py` in services/avatar-engine.",
                "weights_missing",
            )
        return path

    # ---------- status ----------
    def files_for(self, capability: str) -> list[ModelFile]:
        return [f for f in self.files if capability in f.capabilities]

    def capability_ready(self, capability: str) -> bool:
        """All files the capability REQUIRES are present. Matting models are alternatives and
        optional (a portrait can be prepared with the fallback matte, or without one), so they
        never block a capability; /health still lists whether each one is downloaded."""
        files = [f for f in self.files_for(capability) if f.role != "matting"]
        return bool(files) and all(self.locate(f) is not None for f in files)

    def missing(self, capability: str | None = None) -> list[ModelFile]:
        files = self.files if capability is None else self.files_for(capability)
        return [f for f in files if self.locate(f) is None]

    def model_status(self) -> list[dict]:
        """One entry per model id, in the shape of EngineModelInfo (contract)."""
        groups: dict[str, list[ModelFile]] = {}
        for f in self.files:
            groups.setdefault(f.model_id, []).append(f)
        out = []
        for model_id, files in groups.items():
            out.append({
                "id": model_id,
                "role": files[0].role,
                "downloaded": all(self.locate(f) is not None for f in files),
                "license": files[0].license,
                "commercialUse": all(f.commercial_use for f in files),
                "sizeBytes": sum(f.size for f in files),
            })
        return out

    # ---------- downloading ----------
    def download(self, f: ModelFile, log: Callable[[str], None] = print, retries: int = 4) -> Path:
        """Idempotent: returns the verified local copy, downloading (with resume) if needed."""
        found = self.locate(f)
        if found is not None:
            return found
        dest = self.models_dir / f.relative_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        ctx = ssl.create_default_context()
        last_error: Exception | None = None
        for attempt in range(1, retries + 1):
            have = part.stat().st_size if part.exists() else 0
            if have > f.size:
                part.unlink()
                have = 0
            try:
                if have < f.size:
                    req = urllib.request.Request(f.source_url, headers={"User-Agent": "parlante-avatar-engine"})
                    if have:
                        req.add_header("Range", f"bytes={have}-")
                    with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                        if have and resp.status != 206:
                            have = 0
                        mode = "ab" if have else "wb"
                        t_last = time.monotonic()
                        with open(part, mode) as fh:
                            while True:
                                block = resp.read(1 << 20)
                                if not block:
                                    break
                                fh.write(block)
                                have += len(block)
                                if time.monotonic() - t_last > 5:
                                    t_last = time.monotonic()
                                    log(f"  {f.filename}: {have / 1e6:.0f} / {f.size / 1e6:.0f} MB")
                actual = sha256_file(part)
                if actual != f.sha256:
                    part.unlink(missing_ok=True)
                    raise EngineError("SERVICE_UNAVAILABLE",
                                      f"Checksum mismatch for {f.filename}: got {actual}", "checksum_mismatch")
                os.replace(part, dest)
                st = dest.stat()
                with self._lock:
                    self._verified[os.path.realpath(dest)] = {"size": st.st_size, "mtime_ns": st.st_mtime_ns,
                                                             "sha256": actual}
                    self._save_verified()
                return dest
            except (urllib.error.URLError, OSError, TimeoutError) as exc:
                last_error = exc
                log(f"  {f.filename}: attempt {attempt}/{retries} failed ({exc}); retrying")
                time.sleep(min(2 ** attempt, 20))
        raise EngineError("SERVICE_UNAVAILABLE", f"Could not download {f.filename}: {last_error}", "download_failed")


def collect_model_files() -> list[ModelFile]:
    """MODELS of every installed sub-package. A sub-package without models.py (or one that
    fails to import) contributes nothing: its capability is reported as unavailable."""
    import logging

    files: list[ModelFile] = []
    for sub in SUBPACKAGES:
        name = f"parlante_engine.{sub}.models"
        try:
            module = importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name not in (name, f"parlante_engine.{sub}"):
                logging.getLogger("parlante.registry").warning("models of %s not loaded: %s", sub, exc)
            continue
        except Exception as exc:  # noqa: BLE001
            logging.getLogger("parlante.registry").warning("models of %s not loaded: %s", sub, exc)
            continue
        files.extend(getattr(module, "MODELS", []))
    return files


_registry: Registry | None = None
_registry_lock = threading.Lock()


def get_registry() -> Registry:
    global _registry
    with _registry_lock:
        if _registry is None:
            s = get_settings()
            _registry = Registry(collect_model_files(), s.models_dir, s.model_search_dirs)
        return _registry


def reset_registry() -> None:
    global _registry
    with _registry_lock:
        _registry = None
