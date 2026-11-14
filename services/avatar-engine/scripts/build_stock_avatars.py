#!/usr/bin/env python3
"""Build the photorealistic STOCK avatar library with the engine itself.

Every avatar of `stock/avatars.json` (a structured description + seed) goes through the same
code as the product: generate (text -> portrait, with automatic quality control and retries)
-> prepare (framing, matte, landmarks). The results land in a STAGING directory for human
review; only the slugs passed to `--publish` are copied to `packages/stock-assets`:

    <slug>.jpg          prepared portrait (JPEG, <= 300 KB)
    <slug>.mask.png     alpha matte, same size, white = person
    <slug>.thumb.webp   256-px thumbnail of the cut-out over a neutral gradient
    src/photoreal-avatars.data.ts   catalogue entries (prompt, seed, model, rig) — generated

    python scripts/build_stock_avatars.py --staging out/stock                  # generate all
    python scripts/build_stock_avatars.py --staging out/stock --only lucia,erik --seed-offset 1
    python scripts/build_stock_avatars.py --staging out/stock --sheet           # contact sheet
    python scripts/build_stock_avatars.py --staging out/stock --publish lucia,samuel,...

Synthetic people only: nothing here reads a photo of a real person.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from parlante_engine.core import backends  # noqa: E402
from parlante_engine.core.config import find_repo_root  # noqa: E402
from parlante_engine.core.errors import EngineError  # noqa: E402

MAX_PORTRAIT_BYTES = 300 * 1024
THUMB_SIDE = 256


def load_manifest() -> dict:
    return json.loads((ROOT / "stock" / "avatars.json").read_text(encoding="utf-8"))


def generate_one(entry: dict, size: int, staging: Path, seed_offset: int, attempts: int | None) -> dict:
    from parlante_engine.matting.api import refine_edges
    from parlante_engine.portrait.prompts import PortraitSpec
    from parlante_engine.portrait.service import GenerateJob, run_generate
    from parlante_engine.prepare.service import PrepareJob, run_prepare

    out = staging / entry["slug"]
    if out.exists():
        shutil.rmtree(out)
    (out / "gen").mkdir(parents=True)
    (out / "prep").mkdir()
    seed = int(entry["seed"]) + seed_offset
    t0 = time.perf_counter()
    gen = run_generate(GenerateJob(output_dir=out / "gen", seed=seed, width=size, height=size,
                                   spec=PortraitSpec(**entry["spec"]), max_attempts=attempts))
    t1 = time.perf_counter()
    prep = run_prepare(PrepareJob(Path(gen["imagePath"]), out / "prep"))
    t2 = time.perf_counter()
    portrait = cv2.imread(prep["portraitPath"], cv2.IMREAD_COLOR)
    alpha = None
    if prep["maskPath"]:
        alpha = refine_edges(cv2.imread(prep["maskPath"], cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255.0)
        cv2.imwrite(str(out / "mask.png"), (alpha * 255.0 + 0.5).astype(np.uint8), [cv2.IMWRITE_PNG_COMPRESSION, 9])
    quality = 92
    while True:
        ok, buf = cv2.imencode(".jpg", portrait, [cv2.IMWRITE_JPEG_QUALITY, quality, cv2.IMWRITE_JPEG_OPTIMIZE, 1,
                                                  cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
        if not ok:
            raise EngineError("INTERNAL", "Could not encode the stock portrait.")
        if len(buf) <= MAX_PORTRAIT_BYTES or quality <= 70:
            break
        quality -= 3
    (out / "portrait.jpg").write_bytes(buf.tobytes())
    h, w = portrait.shape[:2]
    thumb = portrait.astype(np.float32)
    if alpha is not None:
        ramp = np.linspace(238, 206, h, dtype=np.float32)[:, None, None] * np.ones((1, w, 3), np.float32)
        thumb = thumb * alpha[..., None] + ramp * (1 - alpha[..., None])
    thumb = cv2.resize(thumb.astype(np.uint8), (THUMB_SIDE, THUMB_SIDE), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(out / "thumb.webp"), thumb, [cv2.IMWRITE_WEBP_QUALITY, 82])
    gen_meta = json.loads((out / "gen" / "portrait.json").read_text(encoding="utf-8"))
    meta = {
        "slug": entry["slug"],
        "seed": seed,
        "seedUsed": gen_meta["seedUsed"],
        "prompt": gen_meta["prompt"],
        "negativePrompt": gen_meta["negativePrompt"],
        "model": gen_meta["model"],
        "qc": gen_meta["qc"],
        "attempts": gen_meta["attempts"],
        "width": w,
        "height": h,
        "landmarks": prep["landmarks"],
        "landmarksSource": prep["landmarksSource"],
        "pose": prep.get("pose"),
        "matteModel": prep.get("matteModel"),
        "jpegQuality": quality,
        "portraitBytes": len(buf),
        "seconds": {"generate": round(t1 - t0, 1), "prepare": round(t2 - t1, 1)},
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    return meta


def contact_sheet(staging: Path, slugs: list[str]) -> Path:
    tiles = []
    for slug in slugs:
        d = staging / slug
        if not (d / "portrait.jpg").exists():
            continue
        img = cv2.imread(str(d / "portrait.jpg"))
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        tile = cv2.resize(img, (384, 384), interpolation=cv2.INTER_AREA)
        label = f"{slug} s{meta['seedUsed']} {'OK' if meta['qc']['passed'] else ','.join(meta['qc']['issues'])}"
        cv2.putText(tile, label, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3)
        cv2.putText(tile, label, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
        tiles.append(tile)
    rows = []
    for i in range(0, len(tiles), 4):
        row = tiles[i:i + 4]
        row += [np.zeros_like(tiles[0])] * (4 - len(row))
        rows.append(np.hstack(row))
    path = staging / "sheet.jpg"
    cv2.imwrite(str(path), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])
    return path


def _ts(value, indent: int = 2, level: int = 1) -> str:
    """Tiny JSON -> TypeScript literal printer (single quotes, trailing commas: Prettier style)."""
    pad, pad_in = " " * (indent * level), " " * (indent * (level + 1))
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [f"{pad_in}{k if k.isidentifier() else repr(k)}: {_ts(v, indent, level + 1)}," for k, v in value.items()]
        return "{\n" + "\n".join(items) + f"\n{pad}}}"
    if isinstance(value, list):
        if all(isinstance(v, str) for v in value):
            inline = "[" + ", ".join(_ts(v) for v in value) + "]"
            if len(inline) < 80:
                return inline
        items = [f"{pad_in}{_ts(v, indent, level + 1)}," for v in value]
        return "[\n" + "\n".join(items) + f"\n{pad}]"
    if isinstance(value, str):
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return repr(round(value, 4))
    return str(value)


def publish(staging: Path, slugs: list[str], manifest: dict) -> None:
    repo = find_repo_root()
    assets = repo / "packages" / "stock-assets" / "assets" / "avatars"
    assets.mkdir(parents=True, exist_ok=True)
    by_slug = {e["slug"]: e for e in manifest["avatars"]}
    entries = []
    for slug in slugs:
        d = staging / slug
        entry = by_slug[slug]
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        shutil.copyfile(d / "portrait.jpg", assets / f"{slug}.jpg")
        shutil.copyfile(d / "mask.png", assets / f"{slug}.mask.png")
        shutil.copyfile(d / "thumb.webp", assets / f"{slug}.thumb.webp")
        entries.append({
            "id": f"real_{slug}",
            "name": entry["name"],
            "gender": entry["spec"]["gender"],
            "ageGroup": entry["ageGroup"],
            "style": entry["style"],
            "description": entry["description"],
            "tags": entry["tags"],
            "traits": entry["traits"],
            "prompt": meta["prompt"],
            "seed": meta["seedUsed"],
            "model": meta["model"],
            "portraitFile": f"{slug}.jpg",
            "maskFile": f"{slug}.mask.png",
            "rig": {
                "imageWidth": meta["width"],
                "imageHeight": meta["height"],
                "landmarks": meta["landmarks"],
                "landmarksSource": meta["landmarksSource"],
            },
        })
    body = ",\n".join("  " + _ts(e) for e in entries)
    text = (
        "import type { StockPhotorealAvatarMeta } from '@parlante/shared';\n\n"
        "/**\n"
        " * GENERATED by services/avatar-engine/scripts/build_stock_avatars.py — do not edit by hand.\n"
        " * Source of truth: services/avatar-engine/stock/avatars.json (structured description + seed of\n"
        " * each SYNTHETIC person). Regenerate with `--publish`; images live in ../assets/avatars/.\n"
        " */\n"
        f"export const PHOTOREAL_AVATAR_DATA: readonly StockPhotorealAvatarMeta[] = [\n{body},\n];\n"
    )
    (repo / "packages" / "stock-assets" / "src" / "photoreal-avatars.data.ts").write_text(text, encoding="utf-8")
    print(f"published {len(entries)} avatars to {assets}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--staging", required=True, help="directory for generated candidates")
    ap.add_argument("--only", help="comma-separated slugs (default: all)")
    ap.add_argument("--seed-offset", type=int, default=0, help="added to the manifest seed (to try another person)")
    ap.add_argument("--attempts", type=int, help="quality-control attempts per avatar")
    ap.add_argument("--sheet", action="store_true", help="only (re)build the contact sheet of the staging dir")
    ap.add_argument("--publish", help="comma-separated slugs to copy from staging into packages/stock-assets")
    args = ap.parse_args()
    manifest = load_manifest()
    staging = Path(args.staging).resolve()
    staging.mkdir(parents=True, exist_ok=True)
    all_slugs = [e["slug"] for e in manifest["avatars"]]
    if args.publish:
        slugs = [s for s in args.publish.split(",") if s]
        unknown = [s for s in slugs if s not in all_slugs]
        if unknown:
            print(f"unknown slugs: {unknown}", file=sys.stderr)
            return 2
        publish(staging, slugs, manifest)
        return 0
    slugs = [s for s in (args.only.split(",") if args.only else all_slugs) if s]
    if not args.sheet:
        backends.limit_threads()
        for entry in manifest["avatars"]:
            if entry["slug"] not in slugs:
                continue
            try:
                meta = generate_one(entry, int(manifest.get("size", 768)), staging, args.seed_offset, args.attempts)
            except EngineError as exc:
                print(f"{entry['slug']}: FAILED [{exc.code}] {exc.message}", flush=True)
                continue
            print(json.dumps({k: meta[k] for k in ("slug", "seedUsed", "width", "portraitBytes", "seconds")}
                             | {"qc": meta["qc"]["passed"], "issues": meta["qc"]["issues"],
                                "attempts": len(meta["attempts"])}), flush=True)
    print(contact_sheet(staging, all_slugs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
