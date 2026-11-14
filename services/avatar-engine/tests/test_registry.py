"""Model registry: declarations are validated, files are located only when their sha256 matches,
Hugging Face cache layouts are reused, and unsafe formats / hosts are refused."""
from __future__ import annotations

import hashlib

import pytest

from parlante_engine.core.registry import ModelFile, Registry, collect_model_files

DATA = b"fake-onnx-weights" * 100
SHA = hashlib.sha256(DATA).hexdigest()


def _file(**kw) -> ModelFile:
    base = dict(model_id="m", role="animation", capabilities=("animate",), repo="org/name", revision="abc123",
                filename="sub/model.onnx", sha256=SHA, size=len(DATA), license="MIT", commercial_use=True)
    base.update(kw)
    return ModelFile(**base)


def test_located_only_with_matching_checksum(tmp_path):
    f = _file()
    reg = Registry([f], tmp_path)
    assert reg.locate(f) is None and not reg.capability_ready("animate")
    dest = tmp_path / f.relative_path
    dest.parent.mkdir(parents=True)
    dest.write_bytes(DATA)
    assert reg.locate(f) == dest and reg.capability_ready("animate")
    assert reg.model_status() == [{"id": "m", "role": "animation", "downloaded": True, "license": "MIT",
                                   "commercialUse": True, "sizeBytes": len(DATA)}]
    dest.write_bytes(DATA[:-1] + b"X")                 # same size, different content
    assert Registry([f], tmp_path).locate(f) is None
    with pytest.raises(Exception) as exc:
        Registry([f], tmp_path).require(f)
    assert getattr(exc.value, "code", None) == "SERVICE_UNAVAILABLE"


def test_hugging_face_cache_layout_is_reused(tmp_path):
    f = _file()
    cache = tmp_path / "hf"
    snap = cache / "hub" / "models--org--name" / "snapshots" / "abc123" / "sub"
    snap.mkdir(parents=True)
    (snap / "model.onnx").write_bytes(DATA)
    reg = Registry([f], tmp_path / "models", [cache])
    assert reg.locate(f) == snap / "model.onnx"
    assert (tmp_path / "models" / ".verified.json").is_file()      # checksum cached for the next start


@pytest.mark.parametrize("kw", [
    dict(filename="model.pth"), dict(filename="weights.pkl"), dict(filename="model.ckpt"),
    dict(filename="../escape.onnx"), dict(filename="/abs/model.onnx"),
    dict(revision=None), dict(sha256="abc"), dict(role="nonsense"), dict(capabilities=("fly",)),
    dict(repo=None, revision=None, url="https://example.com/model.onnx"),
    dict(url="https://storage.googleapis.com/mediapipe-models/x.tflite"),      # both repo and url
])
def test_unsafe_or_malformed_declarations_are_refused(kw):
    with pytest.raises(ValueError):
        _file(**kw)


def test_mediapipe_url_is_allowed_and_conflicts_detected(tmp_path):
    ok = _file(repo=None, revision=None, filename="seg.tflite",
               url="https://storage.googleapis.com/mediapipe-models/image_segmenter/x/float32/1/seg.tflite")
    assert str(ok.relative_path) == "mediapipe/seg.tflite"
    with pytest.raises(ValueError):
        Registry([_file(), _file(sha256="0" * 64)], tmp_path)


def test_declared_models_are_complete_and_pinned():
    files = collect_model_files()
    ids = {f.model_id for f in files}
    assert {"liveportrait-onnx", "ditto-audio2motion", "mediapipe-blazeface-onnx", "mediapipe-facemesh-onnx",
            "mediapipe-selfie-multiclass"} <= ids
    for f in files:
        assert f.license and len(f.sha256) == 64 and f.size > 0
        assert f.source_url.startswith(("https://huggingface.co/", "https://storage.googleapis.com/mediapipe-models/"))
        if f.repo:
            assert len(f.revision) == 40, f"{f.key}: revision must be a full commit hash"
    audio_only = [f for f in files if f.model_id == "ditto-audio2motion"]
    assert all(f.capabilities == ("animate-audio",) for f in audio_only)     # optional download
