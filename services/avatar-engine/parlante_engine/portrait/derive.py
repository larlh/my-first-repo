"""Derived artefact: OpenVINO IR of the UNet with FP16-compressed weights.

Why: compiling the 3.4 GB FP32 ONNX directly costs ~2 GB more peak RAM and a much longer load
than the 1.7 GB IR, which OpenVINO memory-maps. The IR is derived locally from the
checksummed ONNX (never downloaded), into `<models_dir>/derived/portrait/`, the first time a
portrait is generated or when `python -m parlante_engine.portrait.derive` is run.
A manifest records the checksums of the sources, so a changed source triggers a rebuild.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import EngineError
from parlante_engine.core.registry import get_registry

from .models import UNET_DATA, UNET_GRAPH

_lock = threading.Lock()
FORMAT = 1


def derived_dir() -> Path:
    return get_settings().models_dir / "derived" / "portrait"


def unet_ir_path() -> Path:
    return derived_dir() / "unet_fp16.xml"


def _manifest_path() -> Path:
    return derived_dir() / "unet_fp16.json"


def unet_ir_ready() -> bool:
    xml, manifest = unet_ir_path(), _manifest_path()
    try:
        info = json.loads(manifest.read_text())
        bin_path = xml.with_suffix(".bin")
        return (info.get("format") == FORMAT and info.get("sources") == [UNET_GRAPH.sha256, UNET_DATA.sha256]
                and xml.is_file() and bin_path.stat().st_size == info.get("binBytes"))
    except (OSError, ValueError):
        return False


def _link_or_copy(src: Path, dst: Path) -> None:
    real = Path(os.path.realpath(src))
    try:
        os.link(real, dst)
    except OSError:
        shutil.copyfile(real, dst)


def ensure_unet_ir(log: Callable[[str], None] | None = None) -> Path:
    """Path of the derived UNet IR, building it if missing. Raises SERVICE_UNAVAILABLE when the
    source weights are not downloaded."""
    with _lock:
        if unet_ir_ready():
            return unet_ir_path()
        import openvino as ov

        reg = get_registry()
        graph, data = reg.require(UNET_GRAPH), reg.require(UNET_DATA)
        out_dir = derived_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        t0 = time.perf_counter()
        if log:
            log("Deriving the OpenVINO IR of the UNet (one-off, ~10 s)…")
        # OpenVINO only follows external-data references that stay inside the model's own
        # directory; Hugging Face caches hold symlinks, so stage real files side by side.
        stage = Path(tempfile.mkdtemp(prefix="stage-", dir=out_dir))
        try:
            _link_or_copy(graph, stage / "model.onnx")
            _link_or_copy(data, stage / "model.onnx_data")
            model = ov.Core().read_model(str(stage / "model.onnx"))
            tmp_xml = stage / "unet_fp16.xml"
            ov.save_model(model, str(tmp_xml), compress_to_fp16=True)
            del model
            os.replace(tmp_xml.with_suffix(".bin"), unet_ir_path().with_suffix(".bin"))
            os.replace(tmp_xml, unet_ir_path())
        except EngineError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise EngineError("SERVICE_UNAVAILABLE", f"Could not derive the UNet IR: {exc}", "derive_failed") from exc
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        info = {"format": FORMAT, "sources": [UNET_GRAPH.sha256, UNET_DATA.sha256],
                "binBytes": unet_ir_path().with_suffix(".bin").stat().st_size,
                "seconds": round(time.perf_counter() - t0, 1), "openvino": ov.__version__}
        _manifest_path().write_text(json.dumps(info, indent=1))
        if log:
            log(f"UNet IR ready ({info['binBytes'] / 1e9:.2f} GB, {info['seconds']} s).")
        return unet_ir_path()


if __name__ == "__main__":
    print(ensure_unet_ir(print))
