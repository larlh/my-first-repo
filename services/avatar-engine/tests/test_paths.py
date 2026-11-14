"""Path validation: nothing outside AVATAR_ENGINE_WORK_DIR is ever accepted."""
from __future__ import annotations

import os

import pytest

from parlante_engine.core.errors import EngineError
from parlante_engine.core.paths import resolve_in_work_dir, resolve_input_file, resolve_output_dir


def _reason(fn, *args):
    with pytest.raises(EngineError) as exc:
        fn(*args)
    return exc.value


def test_accepts_files_inside(work_dir):
    f = work_dir / "job1" / "in.png"
    f.parent.mkdir()
    f.write_bytes(b"x" * 10)
    assert resolve_input_file(str(f), "imagePath") == f.resolve()
    assert resolve_input_file("job1/in.png", "imagePath") == f.resolve()       # relative = inside work dir


@pytest.mark.parametrize("bad", ["/etc/passwd", "../outside.png", "job1/../../outside.png", "/", "",
                                 "job1/\x00evil", "a" * 5000])
def test_rejects_outside_and_malformed(work_dir, bad):
    err = _reason(resolve_in_work_dir, bad, "imagePath")
    assert err.code == "VALIDATION_ERROR" and err.status == 400


def test_rejects_work_dir_itself_and_prefix_siblings(work_dir):
    assert _reason(resolve_in_work_dir, str(work_dir), "p").reason == "path_outside_work_dir"
    sibling = work_dir.parent / (work_dir.name + "-evil")
    sibling.mkdir()
    (sibling / "x.png").write_bytes(b"x")
    assert _reason(resolve_in_work_dir, str(sibling / "x.png"), "p").reason == "path_outside_work_dir"


def test_rejects_symlink_escape(work_dir, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret")
    link = work_dir / "link.png"
    os.symlink(secret, link)
    assert _reason(resolve_input_file, str(link), "imagePath").reason == "path_outside_work_dir"
    outside_dir = tmp_path / "elsewhere"
    outside_dir.mkdir()
    os.symlink(outside_dir, work_dir / "outdir")
    assert _reason(resolve_output_dir, str(work_dir / "outdir" / "sub")).reason == "path_outside_work_dir"
    assert not (outside_dir / "sub").exists()


def test_missing_file_and_size_limit(work_dir):
    assert _reason(resolve_input_file, str(work_dir / "nope.png"), "imagePath").reason == "file_not_found"
    big = work_dir / "big.bin"
    big.write_bytes(b"0" * 2048)
    err = _reason(resolve_input_file, str(big), "imagePath", 1024)
    assert err.code == "PAYLOAD_TOO_LARGE" and err.status == 413


def test_output_dir_created_inside_only(work_dir):
    out = resolve_output_dir(str(work_dir / "a" / "b"))
    assert out.is_dir()
    f = work_dir / "file.txt"
    f.write_text("x")
    assert _reason(resolve_output_dir, str(f)).reason == "not_a_directory"
    assert _reason(resolve_output_dir, "/tmp/parlante-escape-test").reason == "path_outside_work_dir"
    assert not os.path.exists("/tmp/parlante-escape-test")
