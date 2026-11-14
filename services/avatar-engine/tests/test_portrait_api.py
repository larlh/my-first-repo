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
        from types import SimpleNamespace

        from parlante_engine.portrait.prompts import approx_tokens

        self.closed = False
        self.seeds: list[int] = []
        self.calls: list[dict] = []
        self.emphasis: list = []
        self._text = None
        self.tokenizer = SimpleNamespace(count=approx_tokens)
        StubPipeline.instances.append(self)

    def encode(self, prompt, emphasis=None):
        self.emphasis.append(emphasis)
        return np.zeros((1, 77, 768), np.float32)

    def generate(self, positive, negative, seed, width, height, steps=20, guidance=5.5, on_eval=None,
                 should_cancel=None, embeddings=None, init_image=None, strength=1.0, release_unet=False):
        self.seeds.append(seed)
        self.last = dict(positive=positive, negative=negative, width=width, height=height, steps=steps)
        self.calls.append(dict(seed=seed, width=width, height=height, strength=strength,
                               init=None if init_image is None else init_image.shape))
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


def passing_report(face_height: float = 0.47, eye_y: float = 0.42) -> QcReport:
    """A face already framed as a presenter shot (no re-framing needed) unless told otherwise."""
    lm = {k: {"x": 0.5, "y": eye_y} for k in ("leftEye", "rightEye", "mouthLeft", "mouthRight", "chin")}
    return QcReport(True, [], 1, {"mouthOpen": 0.01, "faceHeight": face_height, "centerOffset": 0.0}, lm, 0.0)


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
    pipe = StubPipeline.instances[-1]
    assert "man" in pipe.last["positive"] and "woman, female" in pipe.last["negative"]
    assert pipe.emphasis == [{"man": 1.3}, None]          # positive prompt of a man: noun weighted; negative: never
    image = cv2.imdecode(np.fromfile(done["result"]["imagePath"], np.uint8), cv2.IMREAD_COLOR)
    assert image.shape == (576, 768, 3)


def test_large_portraits_are_composed_at_512_and_refined_at_the_target_size(client, work_dir, monkeypatch):
    """Above 512 px: quality control (and retries) on a <= 512 px composition, then ONE
    image-to-image pass at the requested size from the approved composition, same seed."""
    reports = iter([QcReport(False, ["head_tilted"], 1, {}, passing_report().landmarks5, 1.4),
                    passing_report(), passing_report()])
    monkeypatch.setattr(service, "check_portrait", lambda rgb: next(reports))
    r = client.post("/v1/portraits/generate", json={"prompt": "a woman", "seed": 9, "width": 768, "height": 768,
                                                    "outputDir": str(work_dir / "g7")})
    done = wait_job(client, r.json()["jobId"])
    assert done["status"] == "succeeded", done
    calls = StubPipeline.instances[-1].calls
    second = 9 + service.SEED_STRIDE
    assert [(c["seed"], c["width"], c["height"], c["init"]) for c in calls] == [
        (9, 512, 512, None), (second, 512, 512, None), (second, 768, 768, (768, 768, 3))]
    assert calls[-1]["strength"] == service.REFINE_STRENGTH
    res = done["result"]
    assert (res["width"], res["height"], res["attempts"], res["seedUsed"], res["qcPassed"]) == (768, 768, 2, second, True)
    meta = json.loads((work_dir / "g7" / "portrait.json").read_text())
    assert meta["compositionSize"] == [512, 512] and meta["refineStrength"] == service.REFINE_STRENGTH
    # a 512-pixel request whose composition is already a head-and-shoulders shot is a single stage
    r = client.post("/v1/portraits/generate", json={"prompt": "a woman", "seed": 9, "outputDir": str(work_dir / "g8")})
    wait_job(client, r.json()["jobId"])
    assert [(c["width"], c["init"]) for c in StubPipeline.instances[-1].calls] == [(512, None)]


def test_small_faces_are_reframed_and_refined_even_at_512(client, work_dir, monkeypatch):
    """A wide composition (face 25 % of the height) is cropped to the presenter framing and
    re-rendered at the requested size, so the delivered face is large."""
    reports = iter([passing_report(face_height=0.25, eye_y=0.30), passing_report()])
    monkeypatch.setattr(service, "check_portrait", lambda rgb: next(reports))
    r = client.post("/v1/portraits/generate", json={"prompt": "a man", "seed": 2, "outputDir": str(work_dir / "g9")})
    done = wait_job(client, r.json()["jobId"])
    assert done["status"] == "succeeded", done
    calls = StubPipeline.instances[-1].calls
    assert [(c["width"], c["init"], c["strength"]) for c in calls] == [
        (512, None, 1.0), (512, (512, 512, 3), service.REFINE_STRENGTH)]
    meta = json.loads((work_dir / "g9" / "portrait.json").read_text())
    x0, y0, cw, ch = meta["compositionCrop"]
    assert cw == ch == round(0.25 * 512 / service.FRAME_FACE_FRACTION)          # 272 px square
    assert x0 == round(256 - cw / 2) and y0 == round(0.30 * 512 - service.FRAME_EYE_LINE * ch)


def test_presenter_crop_geometry():
    crop = service.presenter_crop
    assert crop(passing_report(), 512, 512, 1.0) is None                        # already framed
    assert crop(QcReport(False, ["no_face"], 0), 512, 512, 1.0) is None
    # face near the top-left corner: the crop is clamped inside the image
    lm = {k: {"x": 0.2, "y": 0.1} for k in ("leftEye", "rightEye", "mouthLeft", "mouthRight", "chin")}
    corner = QcReport(True, [], 1, {"faceHeight": 0.2, "centerOffset": -0.3}, lm, 0.0)
    x0, y0, cw, ch = crop(corner, 512, 512, 1.0)
    assert (x0, y0) == (0, 0) and cw == ch == round(0.2 * 512 / service.FRAME_FACE_FRACTION)
    # a 4:3 target keeps the aspect ratio and never exceeds the image
    x0, y0, cw, ch = crop(passing_report(face_height=0.3, eye_y=0.4), 512, 384, 4 / 3)
    assert abs(cw / ch - 4 / 3) < 0.02 and x0 >= 0 and y0 >= 0 and x0 + cw <= 512 and y0 + ch <= 384


def test_failed_quality_control_retries_with_derived_seeds_and_keeps_the_best(client, work_dir, monkeypatch):
    reports = iter([QcReport(False, ["mouth_open", "head_tilted"], 1, {}, passing_report().landmarks5, 3.0),
                    QcReport(False, ["mouth_open"], 1, {}, passing_report().landmarks5, 1.2),
                    QcReport(False, ["head_tilted", "not_frontal"], 1, {}, passing_report().landmarks5, 2.5),
                    QcReport(False, ["not_frontal"], 1, {}, passing_report().landmarks5, 1.9)])
    monkeypatch.setattr(service, "check_portrait", lambda rgb: next(reports))
    r = client.post("/v1/portraits/generate", json={"prompt": "a man", "seed": 40, "outputDir": str(work_dir / "g3")})
    done = wait_job(client, r.json()["jobId"])
    assert done["status"] == "succeeded"
    res = done["result"]
    assert StubPipeline.instances[-1].seeds == [40 + k * service.SEED_STRIDE for k in range(4)]
    assert res["attempts"] == 4 and res["qcPassed"] is False and res["qcIssues"] == ["mouth_open"]
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


def test_options_endpoint_lists_template_choices_and_estimates(client):
    body = client.get("/v1/portraits/options").json()
    assert body["genders"] == ["female", "male", "neutral"]
    assert body["age"] == {"min": 18, "max": 90}
    assert "business" in body["styles"] and set(body["styles"]["business"]) == {"female", "male", "neutral"}
    assert "dark" in body["skinTones"] and "light-gray" in body["backgrounds"]
    assert body["size"] == {"min": 384, "max": 768, "multipleOf": 64, "default": 512}
    est = body["performance"]["estimatedSeconds"]
    assert 0 < est["512x512"] < est["640x640"] < est["768x768"]
    assert body["performance"]["steps"] == 20 and body["performance"]["maxAttempts"] == 4


def test_cancel_stops_a_running_generation(client, work_dir, monkeypatch):
    def slow_generate(self, positive, negative, seed, width, height, steps=20, guidance=5.5, on_eval=None,
                      should_cancel=None, embeddings=None, init_image=None, strength=1.0, release_unet=False):
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
def test_real_generation_is_deterministic_two_stage_and_releases_its_memory(work_dir):
    """Real weights: a 384-px single-stage job twice (determinism), then a 576-px two-stage job
    (512-px composition + image-to-image), 10 steps each to keep it short (~1 minute in total on
    4 idle cores)."""
    import gc

    import psutil

    from parlante_engine.core.registry import get_registry

    if not get_registry().capability_ready("generate"):
        pytest.skip("portrait weights not downloaded (run scripts/download_models.py --all)")
    from parlante_engine.portrait.prompts import PortraitSpec

    def run(tag: str, size: int) -> tuple[dict, np.ndarray, dict]:
        out = work_dir / tag
        out.mkdir()
        job = service.GenerateJob(output_dir=out, seed=3, width=size, height=size, steps=10, max_attempts=1,
                                  spec=PortraitSpec(gender="female", age=40, style="business"))
        res = service.run_generate(job)
        meta = json.loads((out / "portrait.json").read_text())
        return res, cv2.imdecode(np.fromfile(res["imagePath"], np.uint8), cv2.IMREAD_COLOR), meta

    proc = psutil.Process()
    res_a, img_a, meta_a = run("a", 384)
    gc.collect()
    rss_after_first = proc.memory_info().rss
    res_b, img_b, _ = run("b", 384)
    assert img_a.shape == (384, 384, 3)
    assert np.array_equal(img_a, img_b)                    # same request -> same portrait
    assert img_a.std() > 20                                # an actual image, not a flat field
    assert meta_a["qc"]["faceCount"] == 1
    assert meta_a["timings"]["composition"]["unetEvals"] == 20 and meta_a["timings"]["refine"] is None

    res_c, img_c, meta_c = run("c", 576)
    assert img_c.shape == (576, 576, 3) and res_c["width"] == 576
    assert meta_c["compositionSize"] == [512, 512]
    assert meta_c["timings"]["composition"]["unetEvals"] == 20
    assert meta_c["timings"]["refine"]["unetEvals"] == 10  # half of the schedule at the target size
    assert meta_c["qc"]["faceCount"] == 1
    gc.collect()
    # the models are released after every job: three jobs must not accumulate memory
    assert proc.memory_info().rss - rss_after_first < 400 * 1024 * 1024
