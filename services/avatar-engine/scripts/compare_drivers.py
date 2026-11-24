#!/usr/bin/env python3
"""Render the same speech with each driver on several portraits and measure the result.

    python scripts/compare_drivers.py --out OUT --portraits a.jpg[:a.mask.png] b.jpg ... \
        --speech es=speech_es.wav:runtime_es.json en=speech_en.wav:runtime_en.json \
        [--variants visemes,audio-lips,audio-full] [--fps 30] [--sheet]

runtime.json = {visemes:[{tMs,viseme}], words?:[...]} (Parlante SceneRuntime). Variants:
  visemes      rig driven by the viseme timeline
  audio-lips   lips from the audio model (opening calibrated per avatar and normalised per clip),
               blinks / brows / head from the seeded rig                              (driver "audio")
  audio-raw    the same with the audio model's lip displacement applied as is
  audio-full   lips, eyes and head pose from the audio model, untouched (Ditto as published)
  auto         what the render worker asks for: the engine decides (metrics carry `driver`, `fit`)
A variant may carry options: `audio-lips@gain=1.3,advance=40,hints=0`.
Writes OUT/<portrait>/<speech>/<variant>/{avatar.mp4, metrics.json}, OUT/results.json and
OUT/table.md. Rendering costs about a second of CPU per frame: keep the speech short.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import lip_metrics as M  # noqa: E402

from parlante_engine.core import backends  # noqa: E402


def parse_variant(spec: str) -> tuple[str, dict]:
    name, _, opts = spec.partition("@")
    out: dict = {}
    for item in filter(None, opts.split(",")):
        k, _, v = item.partition("=")
        out[k] = float(v)
    return name, out


def run_one(portrait: Path, mask: Path | None, wav_path: Path, runtime: dict, spec: str, out: Path, fps: int,
            seed: int) -> dict:
    import cv2

    from parlante_engine.animate.service import AnimateJob, run_animation
    from parlante_engine.core.video import decode_audio

    name, opts = parse_variant(spec)
    hints = opts.get("hints", 1.0) > 0
    job = AnimateJob(portrait, mask, wav_path, out, fps=fps, max_size=512, seed=seed,
                     visemes=runtime.get("visemes") if (name == "visemes" or hints) else None,
                     words=runtime.get("words"),
                     driver={"visemes": "visemes", "auto": "auto"}.get(name, "audio"))
    if name not in ("visemes", "auto"):
        job.audio_motion = "full" if name == "audio-full" else "lips"
        job.audio_lip_drive = "raw" if name == "audio-raw" else "calibrated"
        job.audio_lip_gain = opts.get("gain")
        job.audio_lip_advance_ms = opts.get("advance")
    res = run_animation(job)
    frames, clip_fps = M.read_frames(res["videoPath"])
    tracks = M.measure_tracks(frames)
    wav = decode_audio(wav_path, 16000)
    portrait_rgb = cv2.cvtColor(cv2.imdecode(np.fromfile(str(portrait), np.uint8), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    mask_img = cv2.imdecode(np.fromfile(str(mask), np.uint8), cv2.IMREAD_GRAYSCALE) if mask else None
    metrics = {
        "variant": spec, "frames": len(frames), "fps": clip_fps, "framesWithoutFace": tracks["missing"],
        **M.audio_lip_metrics(tracks["lip"], wav, clip_fps, runtime.get("visemes"), len(wav) / 16.0),
        **M.stability_metrics(frames, tracks, portrait_rgb, mask_img),
        "secondsPerFrame": res["stats"]["secondsPerFrame"], "setupSeconds": res["stats"]["setupSeconds"],
        "totalSeconds": res["stats"]["totalSeconds"], "peakRssMb": res["stats"]["peakRssMb"],
        "loadAvg": [res["stats"]["loadAvgStart"], res["stats"]["loadAvgEnd"]],
        "audioSetupSeconds": res["stats"].get("audioSetupSeconds"),
        "articulationGain": res["stats"].get("audioArticulationGain"),
        "driver": res["driver"], "driverReason": res["stats"].get("driverReason"), "fit": res["stats"].get("fit"),
        "lipTrack": [round(float(v), 4) for v in tracks["lip"]],
    }
    (out / "metrics.json").write_text(json.dumps(metrics, indent=1))
    return metrics


COLUMNS = [("corrOpenVsLoudness", "corr. boca-energía"), ("corrAtBestLag", "corr. en mejor desfase"),
           ("lagMs", "desfase ms"), ("lipInSilenceMax", "boca en silencio (máx)"),
           ("lipAtBilabialsMean", "boca en /p b m/"), ("lipInSpeechMean", "apertura media hablando"),
           ("identityPsnrDb", "identidad PSNR dB"), ("faceShapeDriftPct", "deriva forma %"),
           ("backgroundMad", "fondo MAD"), ("blinks", "parpadeos"), ("headTravelX", "cabeza X %"),
           ("headTravelY", "cabeza Y %"), ("headJitterPctEyeDist", "temblor cabeza %"),
           ("secondsPerFrame", "s/fotograma"), ("setupSeconds", "preparación s")]


def table(rows: list[dict]) -> str:
    by: dict[str, list[dict]] = {}
    for r in rows:
        r = dict(r)
        if "headTravelPctEyeDist" in r:
            r["headTravelX"], r["headTravelY"] = r["headTravelPctEyeDist"]
        by.setdefault(r["variant"], []).append(r)
    lines = ["| variante | n | " + " | ".join(label for _, label in COLUMNS) + " |",
             "|" + "---|" * (len(COLUMNS) + 2)]
    for variant, rs in by.items():
        cells = []
        for key, _ in COLUMNS:
            vals = [float(r[key]) for r in rs if r.get(key) is not None]
            cells.append("—" if not vals else f"{np.mean(vals):.3g} ({np.min(vals):.3g}…{np.max(vals):.3g})")
        lines.append(f"| {variant} | {len(rs)} | " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--portraits", nargs="+", required=True, help="portrait[:mask] ...")
    ap.add_argument("--speech", nargs="+", required=True, help="name=speech.wav:runtime.json ...")
    ap.add_argument("--variants", default="visemes,audio-lips,audio-full")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    backends.limit_threads()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    variants: list[str] = []
    for part in a.variants.split(","):          # commas also separate options inside `@...`
        if "=" in part and variants and "@" in variants[-1] and "@" not in part:
            variants[-1] += "," + part
        else:
            variants.append(part)
    results_path = out / "results.json"
    rows: list[dict] = json.loads(results_path.read_text()) if results_path.exists() else []
    done = {(r["portrait"], r["speech"], r["variant"]) for r in rows}
    for pspec in a.portraits:
        ppath, _, mpath = pspec.partition(":")
        portrait = Path(ppath).resolve()
        mask = Path(mpath).resolve() if mpath else None
        for sspec in a.speech:
            sname, _, rest = sspec.partition("=")
            wav_s, _, rt_s = rest.partition(":")
            runtime = json.loads(Path(rt_s).read_text()) if rt_s else {}
            for spec in variants:
                key = (portrait.stem, sname, spec)
                if key in done:
                    continue
                clip_dir = out / portrait.stem / sname / spec.replace("@", "_").replace("=", "").replace(",", "_")
                m = run_one(portrait, mask, Path(wav_s).resolve(), runtime, spec, clip_dir, a.fps, a.seed)
                m.update({"portrait": portrait.stem, "speech": sname})
                rows.append(m)
                results_path.write_text(json.dumps(rows, indent=1))
                print(json.dumps({k: v for k, v in m.items() if k != "lipTrack"}), flush=True)
    (out / "table.md").write_text(table(rows))
    print(table(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
