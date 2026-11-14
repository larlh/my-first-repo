"""POST /v1/portraits/generate: contract, validation and the job life cycle.

The network is replaced by a stub pipeline that "generates" a fixture image, so these tests
need no diffusion weights and run in seconds; the retry logic, the quality control decision,
the files written and the EngineJob shape are the real code. The slow test at the end runs
the real model."""
from __future__ import annotations

import json
import time
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from parlante_engine.portrait import service
from parlante_engine.portrait.pipeline import GenStats
from parlante_engine.portrait.qc import QcReport

FIXTURES = Path(__file__).parent / "fixtures" / "portraits"


class StubPipeline:
    """Returns a flat image whose red channel encodes the seed; counts evaluations like the real one."""

    instances: list["StubPipeline"] = []

    def __init__(self, paths, threads=None):
        self.closed = False
        self.seeds: list[int] = []
        self._text = None
        StubPipeline.instances.append(self)

    def encode(self, prompt):
        return np.zeros((1, 77, 768), np.float32)

    def generate(self, positive, negative, seed, width, height, steps=20, guidance=5.5, on_eval=None,
                 should_cancel=None, embeddings=None):
        self.seeds.append(seed)
        self.last = dict(positive=positive, negative=negative, width=width, height=height, steps=steps)
        for i in range(steps * 2):
            if should_cancel:
                should_cancel()
            if on_eval:
                on_eval(i + 1, steps * 2)
            time.sleep(0.002)
        img = np.zeros((height, width, 3), np.uint8)
        img[..., 0] = seed % 251
        stats = GenStats(unet_s=0.1, unet_evals=steps * 2)
        return img, stats

    def close(self):
        self.closed = True


def passing_report() -> QcReport:
    lm = {k: {"x": 0.5, "y": 0.5} for k in ("leftEye", "rightEye", "mouthLeft", "mouthRight", "chin")}
    return QcReport(True, [], 1, {"mouthOpen": 0.01}, lm, 0.0)


@pytest.fixture()
def client(work_dir, monkeypatch):
    from parlante_engine.core import jobs, registry
    from parlante_engine.server import create_app

    StubPipeline.instances.clear()
    monkeypatch.setattr(service, "PortraitPipeline", StubPipeline)
    monkeypatch.setattr(service, "pipeline_paths", lambda: None)
    monkeypatch.setattr(service, "_record_perf", lambda *a, **k: None)
    monkeypatch.setattr(service, "check_portrait", lambda rgb: passing_report())
    monkeypatch.setattr(registry.Registry, "capability_ready",
                        lambda self, cap: True if cap == "generate" else registry.Registry.files_for(self, cap) == [])
    monkeypatch.setattr(jobs, "_manager", None)
    with TestClient(create_app()) as c:
        yield c
    jobs.get_job_manager().shutdown()
    monkeypatch.setattr(jobs, "_manager", None)


def wait_job(client: TestClient, job_id: str, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    seen = []
    while time.monotonic() < deadline:
        body = client.get(f"/v1/jobs/{job_id}").json()
        seen.append(body["progress"])
        if body["status"] in ("succeeded", "failed", "canceled"):
            assert seen == sorted(seen)                 # progress never goes backwards
            return body
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_generate_job_succeeds_with_contract_shape(client, work_dir):
    r = client.post("/v1/portraits/generate", json={"prompt": "mujer de 35 años con gafas", "seed": 7,
                                                    "outputDir": str(work_dir / "g1")})
    assert r.status_code == 202, r.text
    job = r.json()
    assert set(job) >= {"jobId", "status", "progress", "etaSec", "result", "error"}
    assert job["status"] in ("queued", "running") and job["etaSec"] is not None and job["etaSec"] > 0
    done = wait_job(client, job["jobId"])
    assert done["status"] == "succeeded" and done["progress"] == 1 and done["error"] is None
    res = done["result"]
    assert res["kind"] == "generate" and res["model"]
    image = Path(res["imagePath"])
    assert image.parent == work_dir / "g1" and image.suffix == ".png"
    decoded = cv2.imdecode(np.fromfile(str(image), np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape == (512, 512, 3)                                     # contract default size
    assert res["width"] == 512 and res["height"] == 512
    assert res["seedUsed"] == 7 and res["attempts"] == 1 and res["qcPassed"] is True and res["qcIssues"] == []
    meta = json.loads((work_dir / "g1" / "portrait.json").read_text())
    assert meta["synthetic"] is True and meta["seed"] == 7 and meta["description"] == "mujer de 35 años con gafas"
    assert "lips closed" in meta["prompt"] and "open mouth" in meta["negativePrompt"]
    assert "woman" in meta["prompt"] and "35 years old" in meta["prompt"]
    assert StubPipeline.instances[-1].closed                                  # memory released after the job


def test_generate_rounds_the_size_and_honours_gender(client, work_dir):
    r = client.post("/v1/portraits/generate", json={"prompt": "a doctor with glasses", "seed": 1, "width": 1000,
                                                    "height": 600, "gender": "male", "outputDir": str(work_dir / "g2")})
    done = wait_job(client, r.json()["jobId"])
    assert done["status"] == "succeeded"
    assert (done["result"]["width"], done["result"]["height"]) == (768, 576)
    last = StubPipeline.instances[-1].last
    assert "man" in last["positive"] and "woman, female" in last["negative"]


def test_failed_quality_control_retries_with_derived_seeds_and_keeps_the_best(client, work_dir, monkeypatch):
    reports = iter([QcReport(False, ["mouth_open", "head_tilted"], 1, {}, passing_report().landmarks5, 3.0),
                    QcReport(False, ["mouth_open"], 1, {}, passing_report().landmarks5, 1.2),
                    QcReport(False, ["head_tilted", "not_frontal"], 1, {}, passing_report().landmarks5, 2.5)])
    monkeypatch.setattr(service, "check_portrait", lambda rgb: next(reports))
    r = client.post("/v1/portraits/generate", json={"prompt": "a man", "seed": 40, "outputDir": str(work_dir / "g3")})
    done = wait_job(client, r.json()["jobId"])
    assert done["status"] == "succeeded"
    res = done["result"]
    assert StubPipeline.instances[-1].seeds == [40, 40 + service.SEED_STRIDE, 40 + 2 * service.SEED_STRIDE]
    assert res["attempts"] == 3 and res["qcPassed"] is False and res["qcIssues"] == ["mouth_open"]
    assert res["seedUsed"] == 40 + service.SEED_STRIDE                         # the least bad attempt
    image = cv2.imdecode(np.fromfile(res["imagePath"], np.uint8), cv2.IMREAD_COLOR)
    assert int(image[0, 0, 2]) == (40 + service.SEED_STRIDE) % 251            # and it is that attempt's image


def test_second_attempt_passing_stops_the_retries(client, work_dir, monkeypatch):
    reports = iter([QcReport(False, ["mouth_open"], 1, {}, passing_report().landmarks5, 1.5), passing_report()])
    monkeypatch.setattr(service, "check_portrait", lambda rgb: next(reports))
    r = client.post("/v1/portraits/generate", json={"prompt": "a woman", "seed": 5, "outputDir": str(work_dir / "g4")})
    res = wait_job(client, r.json()["jobId"])["result"]
    assert res["attempts"] == 2 and res["qcPassed"] is True and res["seedUsed"] == 5 + service.SEED_STRIDE


def test_no_face_in_any_attempt_fails_as_unprocessable(client, work_dir, monkeypatch):
    monkeypatch.setattr(service, "check_portrait", lambda rgb: QcReport(False, ["no_face"], 0, penalty=100.0))
    r = client.post("/v1/portraits/generate", json={"prompt": "a woman", "seed": 5, "outputDir": str(work_dir / "g5")})
    done = wait_job(client, r.json()["jobId"])
    assert done["status"] == "failed" and done["result"] is None
    assert done["error"]["code"] == "UNPROCESSABLE"
    assert not (work_dir / "g5" / "portrait.png").exists()


@pytest.mark.parametrize("body, status, code", [
    ({"prompt": "", "seed": 1}, 400, "VALIDATION_ERROR"),
    ({"prompt": "x" * 1001, "seed": 1}, 400, "VALIDATION_ERROR"),
    ({"prompt": "a woman", "seed": -1}, 400, "VALIDATION_ERROR"),
    ({"prompt": "a woman", "seed": 1, "width": 100}, 400, "VALIDATION_ERROR"),
    ({"prompt": "a woman", "seed": 1, "gender": "robot"}, 400, "VALIDATION_ERROR"),
    ({"prompt": "niña de 9 años", "seed": 1}, 400, "VALIDATION_ERROR"),
    ({"prompt": "a woman"}, 400, "VALIDATION_ERROR"),
])
def test_invalid_requests_are_rejected_before_queueing(client, work_dir, body, status, code):
    body = {"outputDir": str(work_dir / "bad"), **body}
    r = client.post("/v1/portraits/generate", json=body)
    assert r.status_code == status, r.text
    assert r.json()["error"]["code"] == code
    assert StubPipeline.instances == []


def test_output_dir_outside_the_work_dir_is_refused(client, tmp_path):
    r = client.post("/v1/portraits/generate", json={"prompt": "a woman", "seed": 1,
                                                    "outputDir": str(tmp_path / "elsewhere")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_ERROR"
    r = client.post("/v1/portraits/generate", json={"prompt": "a woman", "seed": 1, "outputDir": "../escape"})
    assert r.status_code == 400


def test_missing_weights_answer_503(work_dir, monkeypatch, tmp_path):
    from parlante_engine.core import config, jobs, registry
    from parlante_engine.server import create_app

    monkeypatch.setenv("AVATAR_ENGINE_MODELS_DIR", str(tmp_path / "no-models"))
    monkeypatch.delenv("HF_HOME", raising=False)
    monkeypatch.delenv("AVATAR_ENGINE_MODEL_SEARCH_DIRS", raising=False)
    config.reset_settings_cache()
    registry.reset_registry()
    monkeypatch.setattr(jobs, "_manager", None)
    try:
        with TestClient(create_app()) as c:
            health = c.get("/health").json()
            assert health["capabilities"]["generate"] is False
            ids = {m["id"]: m for m in health["models"]}
            assert ids["realistic-vision-v6-onnx"]["role"] == "portrait-generation"
            assert ids["realistic-vision-v6-onnx"]["downloaded"] is False
            assert ids["ormbg-onnx"]["license"] == "Apache-2.0" and ids["ormbg-onnx"]["commercialUse"] is True
            r = c.post("/v1/portraits/generate", json={"prompt": "a woman", "seed": 1, "outputDir": str(work_dir / "x")})
            assert r.status_code == 503 and r.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    finally:
        jobs.get_job_manager().shutdown()
        monkeypatch.setattr(jobs, "_manager", None)
        config.reset_settings_cache()
        registry.reset_registry()


def test_cancel_stops_a_running_generation(client, work_dir, monkeypatch):
    def slow_generate(self, positive, negative, seed, width, height, steps=20, guidance=5.5, on_eval=None,
                      should_cancel=None, embeddings=None):
        for i in range(2000):
            should_cancel()
            on_eval(min(i + 1, steps * 2), steps * 2)
            time.sleep(0.005)
        raise AssertionError("was not canceled")

    monkeypatch.setattr(StubPipeline, "generate", slow_generate)
    r = client.post("/v1/portraits/generate", json={"prompt": "a woman", "seed": 1, "outputDir": str(work_dir / "g6")})
    job_id = r.json()["jobId"]
    deadline = time.monotonic() + 5
    while client.get(f"/v1/jobs/{job_id}").json()["status"] != "running" and time.monotonic() < deadline:
        time.sleep(0.01)
    body = client.delete(f"/v1/jobs/{job_id}").json()
    assert body["status"] == "canceled"
    assert StubPipeline.instances[-1].closed
    assert not (work_dir / "g6" / "portrait.png").exists()


@pytest.mark.slow
def test_real_generation_is_deterministic_and_passes_basic_checks(work_dir):
    """Real weights, 384x384 and 10 steps to keep it short (~15 s per image on 4 cores)."""
    from parlante_engine.core.registry import get_registry

    if not get_registry().capability_ready("generate"):
        pytest.skip("portrait weights not downloaded (run scripts/download_models.py --all)")
    from parlante_engine.portrait.prompts import PortraitSpec

    def run(tag: str) -> tuple[dict, np.ndarray]:
        out = work_dir / tag
        out.mkdir()
        job = service.GenerateJob(output_dir=out, seed=3, width=384, height=384, steps=10, max_attempts=1,
                                  spec=PortraitSpec(gender="female", age=40, style="business"))
        res = service.run_generate(job)
        return res, cv2.imdecode(np.fromfile(res["imagePath"], np.uint8), cv2.IMREAD_COLOR)

    res_a, img_a = run("a")
    res_b, img_b = run("b")
    assert img_a.shape == (384, 384, 3)
    assert np.array_equal(img_a, img_b)                    # same request -> same portrait
    assert img_a.std() > 20                                # an actual image, not a flat field
    meta = json.loads((work_dir / "a" / "portrait.json").read_text())
    assert meta["qc"]["faceCount"] == 1
    assert meta["timings"]["unetEvals"] == 20
