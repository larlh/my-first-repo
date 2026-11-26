"""Python mirror of the response schemas in packages/shared/src/avatar-engine.ts, used by the
smoke script and the tests when Node/zod is not available. Raises AssertionError with a path."""
from __future__ import annotations

ROLES = {"portrait-generation", "face-detection", "matting", "animation", "other"}
STATUSES = {"queued", "running", "succeeded", "failed", "canceled"}


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _point(v, path):
    assert isinstance(v, dict) and _is_num(v.get("x")) and _is_num(v.get("y")), path
    assert 0 <= v["x"] <= 1 and 0 <= v["y"] <= 1, path


def check_health(h: dict) -> None:
    assert h.get("status") == "ok", "health.status"
    assert isinstance(h.get("version"), str), "health.version"
    assert h.get("device") in ("cpu", "gpu"), "health.device"
    caps = h.get("capabilities")
    assert isinstance(caps, dict) and all(isinstance(caps.get(k), bool) for k in ("generate", "prepare", "animate")), \
        "health.capabilities"
    assert isinstance(h.get("models"), list), "health.models"
    for i, m in enumerate(h["models"]):
        assert isinstance(m.get("id"), str) and m.get("role") in ROLES, f"health.models[{i}]"
        assert isinstance(m.get("downloaded"), bool) and isinstance(m.get("license"), str), f"health.models[{i}]"
        assert isinstance(m.get("commercialUse"), bool), f"health.models[{i}].commercialUse"
    spv = h.get("secondsPerVideoSecond", "missing")
    assert spv is None or (_is_num(spv) and spv > 0), "health.secondsPerVideoSecond"
    spp = h.get("secondsPerPortrait")
    assert spp is None or (_is_num(spp) and spp > 0), "health.secondsPerPortrait"


def check_result(r: dict) -> None:
    kind = r.get("kind")
    if kind == "generate":
        assert isinstance(r.get("imagePath"), str) and isinstance(r.get("model"), str), "result.generate"
    elif kind == "prepare":
        assert isinstance(r.get("portraitPath"), str), "result.portraitPath"
        assert r.get("maskPath") is None or isinstance(r["maskPath"], str), "result.maskPath"
        assert isinstance(r.get("width"), int) and isinstance(r.get("height"), int), "result.size"
        for key in ("leftEye", "rightEye", "mouthLeft", "mouthRight", "chin"):
            _point(r.get("landmarks", {}).get(key), f"result.landmarks.{key}")
        assert r.get("landmarksSource") in ("detected", "user", "estimated"), "result.landmarksSource"
    elif kind == "animate":
        assert isinstance(r.get("videoPath"), str), "result.videoPath"
        assert r.get("alpha") in ("none", "mask-video", "mask-image"), "result.alpha"
        assert r.get("maskPath") is None or isinstance(r["maskPath"], str), "result.maskPath"
        assert isinstance(r.get("width"), int) and isinstance(r.get("height"), int), "result.size"
        assert _is_num(r.get("fps")) and isinstance(r.get("frameCount"), int), "result.fps/frameCount"
        assert isinstance(r.get("model"), str), "result.model"
    else:
        raise AssertionError(f"result.kind = {kind!r}")


def check_job(j: dict) -> None:
    assert isinstance(j.get("jobId"), str), "job.jobId"
    assert j.get("status") in STATUSES, "job.status"
    assert _is_num(j.get("progress")) and 0 <= j["progress"] <= 1, "job.progress"
    assert j.get("etaSec", "missing") is None or (_is_num(j["etaSec"]) and j["etaSec"] >= 0), "job.etaSec"
    assert "result" in j and "error" in j, "job.result/error"
    if j["result"] is not None:
        check_result(j["result"])
    if j["error"] is not None:
        assert isinstance(j["error"].get("code"), str) and isinstance(j["error"].get("message"), str), "job.error"
    if j["status"] == "succeeded":
        assert j["result"] is not None, "succeeded job without result"


def check_error(body: dict) -> None:
    err = body.get("error")
    assert isinstance(err, dict) and isinstance(err.get("code"), str) and isinstance(err.get("message"), str), "error"
