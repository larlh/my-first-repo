#!/usr/bin/env python3
"""End-to-end HTTP smoke test of portrait generation: starts the server, then
    GET /health -> GET /v1/portraits/options -> POST /v1/portraits/generate -> poll (progress,
    ETA) -> POST /v1/portraits/prepare on the generated image -> poll -> files
and checks the error paths (minor, path outside the work dir). Every response is validated with
the Python mirror of the contract and, when the monorepo's node_modules are present, with the
real zod schemas (scripts/validate_contract.ts).

    python scripts/smoke_portrait.py                    # 512x512, ~1 minute on 4 idle cores
    python scripts/smoke_portrait.py --size 768
    python scripts/smoke_portrait.py --url http://127.0.0.1:8090 --work-dir /path/shared
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
sys.path.insert(0, str(HERE))
import contract_check  # noqa: E402

CAPTURE: dict = {"health": [], "jobs": [], "prepareRequests": [], "animateRequests": [], "errors": []}
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


def poll(base: str, job: dict, label: str, timeout: float) -> tuple[dict, list[tuple[float, float, float | None]]]:
    t0 = time.time()
    trace: list[tuple[float, float, float | None]] = []
    last = -1.0
    while True:
        status, job = call(base, "GET", f"/v1/jobs/{job['jobId']}")
        assert status == 200, (status, job)
        contract_check.check_job(job)
        CAPTURE["jobs"].append(job)
        trace.append((round(time.time() - t0, 1), job["progress"], job["etaSec"]))
        if job["progress"] - last >= 0.1 or job["status"] not in ("queued", "running"):
            last = job["progress"]
            print(f"  [{label}] t={time.time() - t0:5.1f}s status={job['status']} progress={job['progress']:.2f} "
                  f"etaSec={job['etaSec']}", flush=True)
        if job["status"] in ("succeeded", "failed", "canceled"):
            return job, trace
        assert time.time() - t0 < timeout, f"{label}: timeout"
        time.sleep(1.0)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", help="use a running server instead of starting one")
    ap.add_argument("--work-dir", help="AVATAR_ENGINE_WORK_DIR of that server")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--prompt", default="mujer de 35 años, pelo castaño, chaqueta azul marino")
    ap.add_argument("--keep", action="store_true", help="keep the temporary work dir")
    args = ap.parse_args()

    proc = None
    tmp = None
    if args.url:
        base, work = args.url.rstrip("/"), Path(args.work_dir or "")
        assert args.work_dir, "--work-dir is required with --url"
    else:
        tmp = tempfile.mkdtemp(prefix="parlante-smoke-portrait-")
        work = Path(tmp) / "work"
        work.mkdir()
        port = free_port()
        env = dict(os.environ, AVATAR_ENGINE_PORT=str(port), AVATAR_ENGINE_HOST="127.0.0.1",
                   AVATAR_ENGINE_WORK_DIR=str(work), AVATAR_ENGINE_STARTUP_BENCHMARK="0")
        proc = subprocess.Popen([sys.executable, "-m", "parlante_engine"], cwd=SERVICE, env=env)
        base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(120):
            try:
                status, health = call(base, "GET", "/health")
                if status == 200:
                    break
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.5)
        else:
            raise AssertionError("server did not answer /health")
        contract_check.check_health(health)
        CAPTURE["health"].append(health)
        ids = {m["id"]: m for m in health["models"]}
        print(f"health: capabilities={health['capabilities']} secondsPerPortrait={health.get('secondsPerPortrait')}")
        for mid in ("realistic-vision-v6-onnx", "ormbg-onnx"):
            print(f"  model {mid}: downloaded={ids[mid]['downloaded']} licence={ids[mid]['license']} "
                  f"commercialUse={ids[mid]['commercialUse']}")
        assert health["capabilities"]["generate"], "portrait weights missing: run scripts/download_models.py --all"

        status, options = call(base, "GET", "/v1/portraits/options")
        assert status == 200 and options["ready"] is True, options
        print(f"options: estimatedSeconds={options['performance']['estimatedSeconds']}")

        # error paths
        status, err = call(base, "POST", "/v1/portraits/generate",
                           {"prompt": "niña de 9 años", "seed": 1, "outputDir": str(work / "bad")})
        assert status == 400 and err["error"]["code"] == "VALIDATION_ERROR", (status, err)
        CAPTURE["errors"].append(err)
        status, err = call(base, "POST", "/v1/portraits/generate",
                           {"prompt": "a woman", "seed": 1, "outputDir": "/etc/parlante-escape"})
        assert status == 400 and err["error"]["code"] == "VALIDATION_ERROR", (status, err)
        CAPTURE["errors"].append(err)
        print("error paths: minor -> 400, path outside the work dir -> 400")

        t0 = time.time()
        status, job = call(base, "POST", "/v1/portraits/generate",
                           {"prompt": args.prompt, "seed": args.seed, "width": args.size, "height": args.size,
                            "outputDir": str(work / "gen"), "clientRef": "smoke-portrait"})
        assert status == 202, (status, job)
        contract_check.check_job(job)
        first_eta = job["etaSec"]
        job, trace = poll(base, job, "generate", 1800)
        assert job["status"] == "succeeded", job
        res = job["result"]
        elapsed = time.time() - t0
        image = Path(res["imagePath"])
        assert image.is_file() and image.parent == work / "gen"
        meta = json.loads((work / "gen" / "portrait.json").read_text())
        mids = [p for (_, p, _) in trace]
        assert mids == sorted(mids), "progress went backwards"
        print(f"generate: {elapsed:.1f} s wall (ETA announced at submit: {first_eta} s), {res['width']}x{res['height']}, "
              f"attempts={res['attempts']} seedUsed={res['seedUsed']} qcPassed={res['qcPassed']} issues={res['qcIssues']}")
        print(f"  timings: {json.dumps(meta['timings'])}")
        print(f"  load average now: {os.getloadavg()[0]:.2f}")

        req = {"imagePath": str(image), "outputDir": str(work / "prep")}
        CAPTURE["prepareRequests"].append(req)
        status, job = call(base, "POST", "/v1/portraits/prepare", req)
        if status == 202:
            job, _ = poll(base, job, "prepare", 600)
            assert job["status"] == "succeeded", job
            prep = job["result"]
            print(f"prepare: portrait {prep['width']}x{prep['height']}, mask={'yes' if prep['maskPath'] else 'no'} "
                  f"(matte model: {prep.get('matteModel')}), landmarks {prep['landmarksSource']}")
        else:
            print(f"prepare skipped: {status} {job}")

        status, health = call(base, "GET", "/health")
        contract_check.check_health(health)
        CAPTURE["health"].append(health)
        print(f"health after the job: secondsPerPortrait={health.get('secondsPerPortrait')}")

        capture_path = work / "capture.json"
        capture_path.write_text(json.dumps(CAPTURE))
        repo = next((p for p in SERVICE.parents if (p / "pnpm-workspace.yaml").exists()), None)
        tsx = repo / "node_modules" / ".bin" / "tsx" if repo else None
        if tsx and tsx.exists():
            out = subprocess.run([str(tsx), str(HERE / "validate_contract.ts"), str(capture_path)], cwd=repo,
                                 capture_output=True, text=True)
            print(out.stdout.strip() or out.stderr.strip())
            assert out.returncode == 0, "zod contract validation failed"
        else:
            print("zod validation skipped (node_modules/.bin/tsx not found); Python mirror passed")
        print(f"OK  (work dir: {work})")
        return 0
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        if tmp and not args.keep:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
