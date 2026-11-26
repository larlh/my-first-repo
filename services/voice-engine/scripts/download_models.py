"""Download the voice engine weights (pinned revisions) and verify their sha256.

    .venv/bin/python scripts/download_models.py           # download what is missing, verify all
    .venv/bin/python scripts/download_models.py --check   # exit 1 if a file is missing or wrong
    .venv/bin/python scripts/download_models.py --list    # files, sizes, state

Files land in the Hugging Face cache (HF_HOME, default ~/.cache/huggingface), so a cache that
already holds them is reused without downloading. A file is hashed once; the result is
remembered by size and modification time in `<data dir>/verified.json`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parlante_voice.config import load_settings  # noqa: E402
from parlante_voice.manifest import LICENCE, WEIGHTS, WeightFile  # noqa: E402


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def cached_path(item: WeightFile) -> Path | None:
    from huggingface_hub import hf_hub_download

    try:
        return Path(
            hf_hub_download(item.repo, item.filename, revision=item.revision, local_files_only=True)
        )
    except Exception:  # not in the cache
        return None


def verify(item: WeightFile, path: Path, memo: dict[str, dict]) -> bool:
    real = path.resolve()
    stat = real.stat()
    if stat.st_size != item.size:
        return False
    seen = memo.get(str(real))
    if seen and seen.get("size") == stat.st_size and seen.get("mtime") == stat.st_mtime:
        return seen.get("sha256") == item.sha256
    digest = sha256_of(real)
    memo[str(real)] = {"size": stat.st_size, "mtime": stat.st_mtime, "sha256": digest}
    return digest == item.sha256


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    settings = load_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    memo_path = settings.data_dir / "verified.json"
    try:
        memo = json.loads(memo_path.read_text())
    except (OSError, ValueError):
        memo = {}

    ok = True
    for item in WEIGHTS:
        path = cached_path(item)
        if path is None and not (args.check or args.list):
            from huggingface_hub import hf_hub_download

            print(f"voice-engine: downloading {item.repo}/{item.filename} ({item.size / 1e9:.2f} GB)")
            path = Path(hf_hub_download(item.repo, item.filename, revision=item.revision))
        if path is None:
            state = "missing"
        elif verify(item, path, memo):
            state = "ok"
        else:
            state = "CHECKSUM MISMATCH"
        ok = ok and state == "ok"
        if args.list or state != "ok":
            print(f"{state:>18}  {item.size / 1e6:9.1f} MB  {LICENCE}  {item.repo}/{item.filename}")
        if state == "CHECKSUM MISMATCH" and not (args.check or args.list):
            print(f"voice-engine: {path} does not match its sha256; delete it and run again", file=sys.stderr)

    memo_path.write_text(json.dumps(memo, indent=1))
    if not ok:
        return 1
    if not args.list:
        print("voice-engine: weights verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
