#!/usr/bin/env python3
"""End-to-end HTTP smoke test: starts the server, then
    GET /health -> POST /v1/portraits/prepare -> poll -> POST /v1/animations -> poll -> files
and validates every response against the contract (packages/shared/src/avatar-engine.ts):
with the real zod schemas through `tsx` when the monorepo's node_modules are present, and
always with the Python mirror in scripts/contract_check.py. Also exercises the error paths
(path outside the work dir, no face, unknown job, cancellation).

    python scripts/smoke.py                       # ~1.2 s clip at 30 fps (a few minutes on CPU)
    python scripts/smoke.py --seconds 0.5 --fps 15
    python scripts/smoke.py --url http://127.0.0.1:8090 --work-dir /path/shared   # server already running
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
sys.path.insert(0, str(HERE))
import contract_check  # noqa: E402

CAPTURE = {"health": [], "jobs": [], "prepareRequests": [], "animateRequests": [], "errors": []}
TOKEN = os.environ.get("AVATAR_ENGINE_TOKEN", "").strip()


def call(base: str, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))      # never through a proxy
    try:
        with opener.open(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def poll(base: str, job: dict, label: str, timeout: float) -> dict:
    t0 = time.time()
    last = -1.0
    while True:
        status, job = call(base, "GET", f"/v1/jobs/{job['jobId']}")
        assert status == 200, (status, job)
        contract_check.check_job(job)
        CAPTURE["jobs"].append(job)
        if job["progress"] != last:
            last = job["progress"]
            print(f"  {label}: {job['status']:9} progress {job['progress']:.2f} eta {job['etaSec']}", flush=True)
        if job["status"] in ("succeeded", "failed", "canceled"):
            return job
        if time.time() - t0 > timeout:
            raise SystemExit(f"{label}: timed out after {timeout:.0f}s")
        time.sleep(1.0)


def write_wav(path: Path, seconds: float, rate: int = 22050) -> None:
    n = int(seconds * rate)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * 180 * i / rate)
                                                         * (0.5 + 0.5 * math.sin(2 * math.pi * 3 * i / rate))))
                               for i in range(n)))


def demo_visemes(seconds: float) -> list[dict]:
    seq = ["O", "NL", "A", "MBP", "I", "E", "NL", "FV", "E", "NL", "I", "DT", "O", "SZ", "A", "MBP", "A", "U"]
    step = 90.0
    cues = [{"tMs": 0, "viseme": "rest"}]
    t = 60.0
    i = 0
    while t < seconds * 1000 - 150:
        cues.append({"tMs": round(t), "viseme": seq[i % len(seq)]})
        t += step
        i += 1
    cues.append({"tMs": round(seconds * 1000 - 100), "viseme": "rest"})
    return cues


def ffprobe(path: str) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                          "stream=width,height,nb_read_frames,r_frame_rate,pix_fmt,codec_name:format_tags=comment",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", help="use a server that is already running (needs --work-dir)")
    ap.add_argument("--work-dir", help="the server's AVATAR_ENGINE_WORK_DIR (default: a temp dir for a new server)")
    ap.add_argument("--image", default=str(SERVICE / "tests/fixtures/synthetic_face.jpg"))
    ap.add_argument("--seconds", type=float, default=1.2)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--timeout", type=float, default=1800)
    ap.add_argument("--keep", action="store_true", help="keep the temp work dir")
    a = ap.parse_args()

    proc = None
    tmp = None
    if a.url:
        if not a.work_dir:
            ap.error("--url needs --work-dir")
        base, work = a.url.rstrip("/"), Path(a.work_dir).resolve()
    else:
        tmp = Path(a.work_dir).resolve() if a.work_dir else Path(tempfile.mkdtemp(prefix="parlante-smoke-"))
        work = tmp
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        env = dict(os.environ, AVATAR_ENGINE_WORK_DIR=str(work), AVATAR_ENGINE_PORT=str(port),
                   AVATAR_ENGINE_HOST="127.0.0.1", AVATAR_ENGINE_STARTUP_BENCHMARK="0")
        log = open(work / "server.log", "w")
        proc = subprocess.Popen([sys.executable, "-m", "parlante_engine"], cwd=SERVICE, env=env, stdout=log,
                                stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{port}"
        print(f"started server pid {proc.pid} on {base} (work dir {work})")
    try:
        t0 = time.time()
        while True:
            try:
                status, health = call(base, "GET", "/health")
                if status == 200:
                    break
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            if proc and proc.poll() is not None:
                raise SystemExit(f"server exited with {proc.returncode}; see {work / 'server.log'}")
            if time.time() - t0 > 120:
                raise SystemExit("server did not answer /health within 120 s")
            time.sleep(0.5)
        contract_check.check_health(health)
        CAPTURE["health"].append(health)
        print(f"health ok in {time.time() - t0:.1f}s: device={health['device']} capabilities={health['capabilities']} "
              f"secondsPerVideoSecond={health['secondsPerVideoSecond']}")
        if not (health["capabilities"]["prepare"] and health["capabilities"]["animate"]):
            raise SystemExit("weights missing: run `python scripts/download_models.py` first")

        job_dir = work / "smoke"
        shutil.rmtree(job_dir, ignore_errors=True)
        (job_dir / "in").mkdir(parents=True)
        image = job_dir / "in" / ("photo" + Path(a.image).suffix)
        shutil.copyfile(a.image, image)
        audio = job_dir / "in" / "speech.wav"
        write_wav(audio, a.seconds)

        # ---- error paths ----
        for label, method, path, body, want in (
            ("path outside work dir", "POST", "/v1/portraits/prepare",
             {"imagePath": "/etc/hostname", "outputDir": str(job_dir / "x")}, (400, "VALIDATION_ERROR")),
            ("output dir outside work dir", "POST", "/v1/portraits/prepare",
             {"imagePath": str(image), "outputDir": "/tmp/parlante-smoke-escape"}, (400, "VALIDATION_ERROR")),
            ("traversal", "POST", "/v1/animations",
             {"portraitPath": str(job_dir / ".." / ".." / "etc" / "passwd"), "audioPath": str(audio),
              "outputDir": str(job_dir / "x")}, (400, "VALIDATION_ERROR")),
            ("bad viseme", "POST", "/v1/animations",
             {"portraitPath": str(image), "audioPath": str(audio), "outputDir": str(job_dir / "x"),
              "visemes": [{"tMs": 0, "viseme": "nope"}]}, (400, "VALIDATION_ERROR")),
            ("unknown job", "GET", "/v1/jobs/does-not-exist", None, (404, "NOT_FOUND")),
        ):
            status, body_out = call(base, method, path, body)
            contract_check.check_error(body_out)
            CAPTURE["errors"].append(body_out)
            assert (status, body_out["error"]["code"]) == want, (label, status, body_out)
            print(f"error path ok: {label} -> {status} {body_out['error']['code']}")
        assert not Path("/tmp/parlante-smoke-escape").exists()

        # a picture without a face must fail with UNPROCESSABLE and a clear reason
        import numpy as np  # noqa: PLC0415
        import cv2  # noqa: PLC0415
        noface = job_dir / "in" / "noface.png"
        yy, xx = np.mgrid[0:400, 0:400]
        cv2.imwrite(str(noface), np.stack([xx % 256, yy % 256, (xx + yy) % 256], -1).astype(np.uint8))
        status, job = call(base, "POST", "/v1/portraits/prepare", {"imagePath": str(noface), "outputDir": str(job_dir / "nf")})
        assert status == 202, (status, job)
        job = poll(base, job, "prepare(no face)", 300)
        assert job["status"] == "failed" and job["error"]["code"] == "UNPROCESSABLE", job
        print(f"error path ok: no face -> failed {job['error']['code']}: {job['error']['message']}")

        # ---- prepare ----
        req = {"imagePath": str(image), "outputDir": str(job_dir / "prepared"), "clientRef": "smoke:prepare"}
        CAPTURE["prepareRequests"].append(req)
        t_prep = time.time()
        status, job = call(base, "POST", "/v1/portraits/prepare", req)
        assert status == 202, (status, job)
        contract_check.check_job(job)
        CAPTURE["jobs"].append(job)
        job = poll(base, job, "prepare", a.timeout)
        assert job["status"] == "succeeded", job
        prep = job["result"]
        t_prep = time.time() - t_prep
        for key in ("portraitPath", "maskPath"):
            assert prep[key] and Path(prep[key]).is_file() and str(Path(prep[key]).resolve()).startswith(str(work)), key
        print(f"prepare ok in {t_prep:.1f}s: {prep['width']}x{prep['height']} landmarks={prep['landmarksSource']}")

        # ---- cancellation: start an animation and cancel it right away ----
        visemes = demo_visemes(a.seconds)
        req = {"portraitPath": prep["portraitPath"], "maskPath": prep["maskPath"], "audioPath": str(audio),
               "visemes": visemes, "fps": a.fps, "maxSize": 512, "outputDir": str(job_dir / "canceled")}
        status, job = call(base, "POST", "/v1/animations", req)
        assert status == 202, (status, job)
        time.sleep(2.0)
        status, job = call(base, "DELETE", f"/v1/jobs/{job['jobId']}")
        contract_check.check_job(job)
        CAPTURE["jobs"].append(job)
        assert status == 200 and job["status"] == "canceled", job
        assert not (job_dir / "canceled" / "avatar.mp4").exists()
        print("cancel ok: DELETE /v1/jobs/:id -> canceled, no partial clip left")

        # ---- animate ----
        req = dict(req, outputDir=str(job_dir / "clip"), clientRef="smoke:animate")
        CAPTURE["animateRequests"].append(req)
        t_anim = time.time()
        status, job = call(base, "POST", "/v1/animations", req)
        assert status == 202, (status, job)
        status, again = call(base, "POST", "/v1/animations", req)            # idempotent retry by clientRef
        assert status == 202 and again["jobId"] == job["jobId"], "clientRef did not return the live job"
        job = poll(base, job, "animate", a.timeout)
        assert job["status"] == "succeeded", job
        res = job["result"]
        t_anim = time.time() - t_anim
        expected = max(1, math.ceil(a.seconds * a.fps - 1e-6))
        assert res["frameCount"] == expected, (res["frameCount"], expected)
        assert res["alpha"] == "mask-video" and res["maskPath"], res
        for key in ("videoPath", "maskPath"):
            info = ffprobe(res[key])
            st = info["streams"][0]
            assert st["codec_name"] == "h264" and st["pix_fmt"] == "yuv420p", st
            assert (st["width"], st["height"]) == (res["width"], res["height"]), st
            assert int(st["nb_read_frames"]) == res["frameCount"], st
            assert st["r_frame_rate"] == f"{a.fps}/1", st
            assert "AI-generated" in info["format"].get("tags", {}).get("comment", ""), "AI metadata missing"
        assert res["width"] == res["height"] == prep["width"] or max(res["width"], res["height"]) == 512
        print(f"animate ok in {t_anim:.1f}s: {res['frameCount']} frames {res['width']}x{res['height']} @ {res['fps']} fps, "
              f"model {res['model']}, {res.get('stats', {}).get('secondsPerFrame')} s/frame")

        status, health = call(base, "GET", "/health")
        contract_check.check_health(health)
        CAPTURE["health"].append(health)
        assert health["secondsPerVideoSecond"] is not None
        print(f"health after run: secondsPerVideoSecond={health['secondsPerVideoSecond']} "
              f"performance={json.dumps(health.get('performance', {}).get('drivers', {}))}")

        capture_path = work / "smoke" / "capture.json"
        capture_path.write_text(json.dumps(CAPTURE, indent=1))
        repo = next((p for p in SERVICE.parents if (p / "pnpm-workspace.yaml").exists()), None)
        tsx = repo / "node_modules/.bin/tsx" if repo else None
        if tsx and tsx.exists():
            out = subprocess.run([str(tsx), str(HERE / "validate_contract.ts"), str(capture_path)], cwd=repo,
                                 capture_output=True, text=True)
            print(out.stdout.strip() or out.stderr.strip())
            if out.returncode != 0:
                raise SystemExit("zod contract validation FAILED")
        else:
            print("zod validation skipped (no node_modules/.bin/tsx); Python contract mirror passed")
        print(f"python contract mirror OK: {len(CAPTURE['jobs'])} job snapshots, {len(CAPTURE['health'])} health")
        print(f"SMOKE OK  clip: {res['videoPath']}  matte: {res['maskPath']}")
        return 0
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        if tmp and not a.keep and not a.work_dir:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
