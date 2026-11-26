"""Self-diagnosis of the avatar engine on THIS machine. Works on Linux, macOS and Windows:

    python -m parlante_engine.selftest                 # everything (a few minutes on a CPU)
    python -m parlante_engine.selftest --quick         # no audio driver, no portrait generation
    python -m parlante_engine.selftest --json out.json # also write the full report

It detects the device, loads every downloaded model, times the frame generator (on a GPU: both
layouts), prepares the bundled SYNTHETIC test face, animates one second of it with each driver
and generates one small portrait, printing seconds and memory for every step. Nothing is
downloaded and nothing leaves the machine. The report is what to send back when the engine is
slow or a GPU is not being used.

Exit status: 0 when every step that could run passed, 1 otherwise. A step whose weights are not
downloaded is reported as SKIPPED, not as a failure.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import shutil
import struct
import subprocess
import sys
import time
import traceback
import wave
from pathlib import Path

FACE = Path(__file__).resolve().parent / "assets" / "selftest_face.jpg"
#: "Hola" twice: closed - open - rounded - closed, so the lips visibly move in one second.
CUES = [{"tMs": 0, "viseme": "rest"}, {"tMs": 80, "viseme": "O"}, {"tMs": 200, "viseme": "NL"},
        {"tMs": 280, "viseme": "A"}, {"tMs": 440, "viseme": "MBP"}, {"tMs": 520, "viseme": "O"},
        {"tMs": 640, "viseme": "NL"}, {"tMs": 720, "viseme": "A"}, {"tMs": 900, "viseme": "rest"}]


def synth_speech(path: Path, seconds: float = 1.0, rate: int = 16000) -> None:
    """A voiced, syllable-shaped test tone (harmonics of 140 Hz under a 4 Hz envelope): enough for
    the audio model to move the lips; it is not speech and nobody's voice."""
    frames = bytearray()
    for i in range(int(seconds * rate)):
        t = i / rate
        envelope = max(0.0, math.sin(2 * math.pi * 4.0 * t)) ** 0.6 if 0.06 < t < seconds - 0.08 else 0.0
        sample = sum(math.sin(2 * math.pi * 140.0 * k * t) / k for k in (1, 2, 3, 4, 5, 7))
        frames += struct.pack("<h", int(9000 * envelope * sample / 2.3))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))


def gpu_memory() -> dict | None:
    """Name and memory of the first NVIDIA GPU as `nvidia-smi` reports it, or None."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=15, check=True).stdout.strip().splitlines()[0]
        name, total, used = (part.strip() for part in out.split(","))
        return {"name": name, "totalMb": int(float(total)), "usedMb": int(float(used))}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def cpu_summary() -> dict:
    info = {"machine": platform.machine(), "processor": platform.processor() or None, "cores": os.cpu_count()}
    try:
        text = Path("/proc/cpuinfo").read_text()
        for line in text.splitlines():
            if line.startswith("model name"):
                info["processor"] = line.split(":", 1)[1].strip()
                break
        flags = next((line.split(":", 1)[1].split() for line in text.splitlines() if line.startswith("flags")), [])
        info["avx2"], info["avx512_bf16"], info["amx"] = "avx2" in flags, "avx512_bf16" in flags, "amx_bf16" in flags
    except OSError:
        pass                      # not Linux: OpenVINO reports the precision it chose further down
    return info


class Report:
    def __init__(self) -> None:
        self.steps: list[dict] = []
        self.data: dict = {}

    def step(self, name: str, fn, skip_reason: str | None = None) -> dict | None:
        from parlante_engine.core import perf

        if skip_reason:
            self.steps.append({"step": name, "status": "skipped", "reason": skip_reason})
            print(f"[SKIPPED] {name}: {skip_reason}", flush=True)
            return None
        t0 = time.monotonic()
        try:
            detail = fn() or {}
            status = "ok"
        except Exception as exc:  # noqa: BLE001 - the whole point is to report what breaks
            detail = {"error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc(limit=6)}
            status = "failed"
        entry = {"step": name, "status": status, "seconds": round(time.monotonic() - t0, 2),
                 "rssMb": round(perf.rss_mb()), "peakRssMb": round(perf.peak_rss_mb())}
        gpu = gpu_memory()
        if gpu:
            entry["gpuUsedMb"] = gpu["usedMb"]
        entry.update(detail)
        self.steps.append(entry)
        shown = {k: v for k, v in entry.items() if k not in ("step", "status", "trace")}
        print(f"[{'OK' if status == 'ok' else 'FAILED'}] {name}: {json.dumps(shown, ensure_ascii=False)}", flush=True)
        return entry if status == "ok" else None

    @property
    def failed(self) -> list[str]:
        return [s["step"] for s in self.steps if s["status"] == "failed"]


def run(args: argparse.Namespace) -> int:
    import parlante_engine
    from parlante_engine.core import backends, perf, privacy
    from parlante_engine.core.config import get_settings
    from parlante_engine.core.registry import get_registry

    backends.limit_threads()
    settings = get_settings()
    reg = get_registry()
    rep = Report()
    work = settings.work_dir / f"selftest-{os.getpid()}"
    work.mkdir(parents=True, exist_ok=True)
    portrait_sha: list[str] = []

    # ---------------------------------------------------------------- environment and device
    import cv2
    import numpy as np
    import onnxruntime as ort
    import psutil

    cuda_ok, cuda_why = backends.probe_cuda()
    try:
        import openvino as ov
        ov_version = ov.get_version()
    except Exception as exc:  # noqa: BLE001
        ov_version = f"not usable ({exc})"
    ffmpeg = shutil.which(os.environ.get("FFMPEG_PATH", "").strip() or "ffmpeg")
    env = {
        "engine": parlante_engine.__version__, "python": platform.python_version(),
        "platform": platform.platform(), "cpu": cpu_summary(),
        "ramTotalMb": round(psutil.virtual_memory().total / 2 ** 20),
        "ramAvailableMb": round(perf.available_mb()), "threads": settings.threads,
        "onnxruntime": ort.__version__, "onnxruntimeProviders": ort.get_available_providers(),
        "openvino": ov_version, "numpy": np.__version__, "opencv": cv2.__version__,
        "ffmpeg": ffmpeg, "gpu": gpu_memory(),
        "cudaUsable": cuda_ok, "cudaNote": cuda_why, "deviceSetting": settings.device,
        "device": backends.device(), "heavyBackend": backends.heavy_backend(),
        "privacy": privacy.status(), "workDir": str(settings.work_dir), "modelsDir": str(settings.models_dir),
    }
    rep.data["environment"] = env
    print("== environment ==")
    for key, value in env.items():
        print(f"  {key}: {json.dumps(value, ensure_ascii=False)}")
    if settings.device != "cpu" and not cuda_ok:
        print(f"  NOTE: no usable GPU -> {cuda_why}")
    models = reg.model_status()
    rep.data["models"] = models
    print("== models ==")
    for m in models:
        print(f"  {m['id']:<30} {m['role']:<20} {m['sizeBytes'] / 2 ** 20:8.1f} MB  "
              f"{'downloaded' if m['downloaded'] else 'MISSING'}  ({m['license']})")
    if not ffmpeg:
        print("  ffmpeg was not found: the animation steps will fail (install it or set FFMPEG_PATH).")
    print("== steps ==", flush=True)

    can_animate = reg.capability_ready("animate") and reg.capability_ready("prepare")
    missing = None if can_animate else "prepare / animate weights are not downloaded (scripts/download_models.py)"

    # ---------------------------------------------------------------- models and generator
    def load_engine() -> dict:
        from parlante_engine.animate.lp import get_engine
        from parlante_engine.prepare.face import get_face_landmarker

        engine = get_engine()
        get_face_landmarker()
        return {"generatorBackend": engine.generator.backend}

    rep.step("load face + animation models", load_engine, missing)

    def bench(backend: str | None):
        def inner() -> dict:
            from parlante_engine.animate.generator import Generator
            from parlante_engine.animate.lp import get_engine

            gen = get_engine().generator if backend is None else Generator(backend=backend)
            rng = np.random.default_rng(0)
            f_s = (rng.standard_normal((1, 32, 16, 64, 64)) * 0.3).astype(np.float32)
            x_s = (rng.random((1, 21, 3)) - 0.5).astype(np.float32)
            gen.raw(f_s, x_s + 0.01, x_s)
            times = []
            for i in range(args.bench_frames):
                t = time.monotonic()
                gen.raw(f_s, x_s + 0.01 * (i + 2), x_s)
                times.append(time.monotonic() - t)
            spf = float(np.median(times))
            return {"backend": gen.backend, "secondsPerFrame": round(spf, 4),
                    "framesPerSecond": round(1.0 / spf, 2), "minutesPer10sVideoAt30fps": round(spf * 300 / 60, 2)}
        return inner

    rep.step("generator benchmark (512 px, default layout)", bench(None), missing)
    if cuda_ok and not missing:
        # Both GPU layouts, so the faster one that WORKS on this card can be chosen with
        # AVATAR_ENGINE_CUDA_GENERATOR (the default tries `whole` and falls back to `split`).
        rep.step("generator benchmark (GPU, whole graph)", bench("ort-whole"))
        rep.step("generator benchmark (GPU, split graph: GridSample on CPU)", bench("ort-split"))

    # ---------------------------------------------------------------- prepare + animate
    prepared: dict = {}

    def prepare() -> dict:
        from parlante_engine.animate.lp import file_sha256
        from parlante_engine.prepare.service import PrepareJob, run_prepare

        src = Path(args.image).resolve() if args.image else FACE
        res = run_prepare(PrepareJob(src, work / "prepare"))
        prepared.update(res)
        portrait_sha.append(file_sha256(Path(res["portraitPath"])))
        return {"size": f"{res['width']}x{res['height']}", "matteModel": res.get("matteModel")}

    rep.step("prepare the test portrait", prepare, missing)
    wav = work / "speech.wav"
    synth_speech(wav, args.seconds)

    def animate(driver: str):
        def inner() -> dict:
            from parlante_engine.animate.service import AnimateJob, run_animation

            if not prepared:
                raise RuntimeError("the portrait could not be prepared")
            res = run_animation(AnimateJob(Path(prepared["portraitPath"]),
                                           Path(prepared["maskPath"]) if prepared.get("maskPath") else None, wav,
                                           work / f"clip-{driver}", fps=args.fps, max_size=512, visemes=CUES,
                                           driver=driver, seed=7))
            stats = res["stats"]
            out = {"frames": res["frameCount"], "secondsPerFrame": stats["secondsPerFrame"],
                   "setupSeconds": stats["setupSeconds"], "backend": stats["backend"],
                   "minutesPer10sVideoAt30fps": round(stats["secondsPerFrame"] * 300 / 60, 2),
                   "clipBytes": Path(res["videoPath"]).stat().st_size}
            if "audioSetupSeconds" in stats:
                out["audioSetupSeconds"] = stats["audioSetupSeconds"]
            return out
        return inner

    no_ffmpeg = None if ffmpeg else "ffmpeg was not found"
    rep.step(f"animate {args.seconds:g} s, driver visemes", animate("visemes"), missing or no_ffmpeg)
    audio_skip = missing or no_ffmpeg or ("--quick" if args.quick else None) or (
        None if reg.capability_ready("animate-audio") else
        "audio-driver weights are not downloaded (scripts/download_models.py --with-audio)")
    rep.step(f"animate {args.seconds:g} s, driver audio", animate("audio"), audio_skip)

    # ---------------------------------------------------------------- portrait generation
    def generate() -> dict:
        from parlante_engine.portrait.service import GenerateJob, run_generate

        (work / "generate").mkdir(parents=True, exist_ok=True)
        res = run_generate(GenerateJob(work / "generate", seed=7, width=args.portrait_size, height=args.portrait_size,
                                       description="woman, 35 years old, short brown hair, navy blazer",
                                       gender="female", steps=args.portrait_steps, max_attempts=1))
        return {"size": f"{res['width']}x{res['height']}", "steps": args.portrait_steps,
                "qcPassed": res["qcPassed"], "qcIssues": res["qcIssues"]}

    try:
        generate_ready = reg.capability_ready("generate")
    except Exception:  # noqa: BLE001
        generate_ready = False
    gen_skip = ("--quick" if args.quick else None) or (
        None if generate_ready else "portrait weights are not downloaded (scripts/download_models.py --all)")
    rep.step(f"generate a {args.portrait_size} px portrait ({args.portrait_steps} steps, 1 attempt)", generate, gen_skip)

    # ---------------------------------------------------------------- summary
    rep.data["steps"] = rep.steps
    rep.data["peakRssMb"] = round(perf.peak_rss_mb())
    rep.data["gpuAfter"] = gpu_memory()
    rep.data["result"] = "failed" if rep.failed else "ok"
    print("== summary ==")
    print(f"  device: {env['device']} ({env['heavyBackend']}), peak memory {rep.data['peakRssMb']} MB"
          + (f", GPU memory in use {rep.data['gpuAfter']['usedMb']} MB" if rep.data["gpuAfter"] else ""))
    for s in rep.steps:
        extra = f"{s['seconds']:.1f} s" if "seconds" in s else s.get("reason", "")
        spf = f", {s['secondsPerFrame']} s/frame" if "secondsPerFrame" in s else ""
        print(f"  {s['status'].upper():<8} {s['step']}  ({extra}{spf})")
    print(f"  RESULT: {'FAILED: ' + ', '.join(rep.failed) if rep.failed else 'OK'}")
    if args.json:
        Path(args.json).write_text(json.dumps(rep.data, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"  report written to {Path(args.json).resolve()}")
    if not args.keep:
        from parlante_engine.animate.lp import avatar_cache_path

        shutil.rmtree(work, ignore_errors=True)
        for sha in portrait_sha:                        # the cache entry of the test face
            avatar_cache_path(sha).unlink(missing_ok=True)
    else:
        print(f"  files kept in {work}")
    return 1 if rep.failed else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m parlante_engine.selftest", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quick", action="store_true", help="skip the audio driver and the portrait generation")
    ap.add_argument("--seconds", type=float, default=1.0, help="length of the animated test clip (default 1)")
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--bench-frames", type=int, default=4)
    ap.add_argument("--portrait-size", type=int, default=384)
    ap.add_argument("--portrait-steps", type=int, default=8)
    ap.add_argument("--image", help="use this photo instead of the bundled synthetic face")
    ap.add_argument("--json", help="write the full report to this file")
    ap.add_argument("--keep", action="store_true", help="keep the generated files")
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
