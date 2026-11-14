#!/usr/bin/env python3
"""Download the engine's weights (idempotent, sha256-verified, resumable).

    python scripts/download_models.py                 # prepare + animate + generate (no audio driver)
    python scripts/download_models.py --minimal       # prepare + animate only (0.56 GB)
    python scripts/download_models.py --with-audio    # + HuBERT/LMDM for audio without a timeline (1.65 GB)
    python scripts/download_models.py --all           # every declared model
    python scripts/download_models.py --import-from /path/to/hf-cache   # hard-link verified files, no download
    python scripts/download_models.py --list          # table: model, file, size, licence, state
    python scripts/download_models.py --check         # exit 0 only if the selected set is complete

Sources: huggingface.co (pinned revisions) and storage.googleapis.com/mediapipe-models.
Only data formats are fetched (ONNX, .tflite/.task, safetensors) — never pickle.
Target: AVATAR_ENGINE_MODELS_DIR (default ./data/models at the repo root). Weights already
present in a Hugging Face cache (HF_HOME, AVATAR_ENGINE_MODEL_SEARCH_DIRS) are reused in place.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parlante_engine.core.config import get_settings  # noqa: E402
from parlante_engine.core.errors import EngineError  # noqa: E402
from parlante_engine.core.registry import get_registry  # noqa: E402


def selected(reg, args) -> list:
    caps = set(args.capability or [])
    if not caps:
        caps = {"prepare", "animate"}
        if not args.minimal:
            caps.add("generate")
        if args.with_audio or args.all:
            caps.add("animate-audio")
    return [f for f in reg.files if caps & set(f.capabilities)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--with-audio", action="store_true", help="include the audio-driven model")
    ap.add_argument("--all", action="store_true", help="include every declared model")
    ap.add_argument("--minimal", action="store_true", help="only what prepare + animate need")
    ap.add_argument("--import-from", metavar="DIR", action="append", default=[],
                    help="Hugging Face cache (HF_HOME layout) to take verified files from (hard link or copy)")
    ap.add_argument("--capability", action="append", choices=["generate", "prepare", "animate", "animate-audio"],
                    help="only the files of this capability (repeatable)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--no-derive", action="store_true", help="skip deriving the split generator graphs")
    args = ap.parse_args()
    reg = get_registry()
    files = selected(reg, args)
    if args.import_from:
        import os
        import shutil

        from parlante_engine.core.registry import Registry
        src = Registry(reg.files, reg.models_dir / ".import-probe", [Path(d) for d in args.import_from])
        linked = 0
        for f in (reg.files if args.all else files):
            dest = reg.models_dir / f.relative_path
            if dest.is_file():
                continue
            found = src.locate(f)
            if found is None:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            real = os.path.realpath(found)
            try:
                os.link(real, dest)
            except OSError:
                shutil.copyfile(real, dest)
            linked += 1
        shutil.rmtree(reg.models_dir / ".import-probe", ignore_errors=True)
        print(f"imported {linked} verified files from {', '.join(args.import_from)}")
    if args.list or args.check:
        missing = 0
        total = 0
        print(f"models dir: {get_settings().models_dir}")
        print(f"{'model':30} {'file':48} {'MB':>8}  {'licence':12} {'commercial':10} state")
        for f in (reg.files if args.list and not args.capability and not args.check else files):
            path = reg.locate(f)
            total += f.size
            missing += path is None
            print(f"{f.model_id:30} {Path(f.filename).name:48} {f.size / 1e6:8.1f}  {f.license:12} "
                  f"{'yes' if f.commercial_use else 'NO':10} {'ok' if path else 'MISSING'}")
        print(f"total {total / 1e9:.2f} GB; missing files: {missing}")
        return 1 if (args.check and missing) else 0
    todo = [f for f in files if reg.locate(f) is None]
    print(f"models dir: {get_settings().models_dir}")
    print(f"{len(files) - len(todo)} of {len(files)} files already present; "
          f"downloading {sum(f.size for f in todo) / 1e6:.0f} MB")
    try:
        for f in todo:
            print(f"- {f.model_id}: {f.filename} ({f.size / 1e6:.1f} MB) from {f.source_url}", flush=True)
            reg.download(f)
        if not args.no_derive and reg.capability_ready("animate"):
            from parlante_engine.core import backends
            if backends.heavy_backend() == "openvino":
                from parlante_engine.animate.generator import build_split, split_ready
                if not split_ready():
                    build_split(log_fn=lambda m: print(m, flush=True))
    except EngineError as exc:
        print(f"ERROR: {exc.message}", file=sys.stderr)
        return 1
    print("all selected weights present and verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
