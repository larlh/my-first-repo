"""HTTP layer without weights: validation, path confinement, auth, error shape, health shape."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import contract_check  # noqa: E402


@pytest.fixture()
def client(work_dir, monkeypatch):
    from parlante_engine.server import create_app

    with TestClient(create_app()) as c:
        yield c


def test_health_matches_contract(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    contract_check.check_health(body)
    ids = {m["id"] for m in body["models"]}
    assert {"liveportrait-onnx", "mediapipe-blazeface-onnx", "mediapipe-facemesh-onnx"} <= ids
    assert all(m["license"] for m in body["models"])
    assert body["device"] in ("cpu", "gpu") and isinstance(body["drivers"]["audio"], bool)


@pytest.mark.parametrize("path,body", [
    ("/v1/portraits/prepare", {"imagePath": "/etc/passwd", "outputDir": "out"}),
    ("/v1/portraits/prepare", {"imagePath": "../../etc/passwd", "outputDir": "out"}),
    ("/v1/animations", {"portraitPath": "/etc/passwd", "audioPath": "/etc/hostname", "outputDir": "out"}),
])
def test_paths_outside_work_dir_are_refused(client, path, body):
    r = client.post(path, json=body)
    if r.status_code == 503:        # weights not downloaded on this machine: the capability check comes first
        pytest.skip("weights missing")
    assert r.status_code == 400
    contract_check.check_error(r.json())
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_request_validation_error_shape(client):
    r = client.post("/v1/animations", json={"portraitPath": "p.png", "audioPath": "a.wav", "outputDir": "o",
                                             "fps": 500, "visemes": [{"tMs": -1, "viseme": "A"}]})
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "VALIDATION_ERROR"
    paths = {i["path"] for i in err["details"]["issues"]}
    assert "fps" in paths and any(p.startswith("visemes") for p in paths)
    r = client.post("/v1/portraits/prepare", json={"outputDir": "o"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_ERROR"
    r = client.post("/v1/portraits/prepare", content=b"{not json", headers={"content-type": "application/json"})
    assert r.status_code == 400


def test_unknown_viseme_and_unknown_job(client):
    r = client.post("/v1/animations", json={"portraitPath": "p.png", "audioPath": "a.wav", "outputDir": "o",
                                             "visemes": [{"tMs": 0, "viseme": "XYZ"}]})
    assert r.status_code == 400
    for method in (client.get, client.delete):
        r = method("/v1/jobs/unknown")
        assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"
    r = client.get("/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"


def test_body_size_limit(client):
    r = client.post("/v1/animations", content=b"x" * (9 * 1024 * 1024), headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_generate_endpoint_answers_in_contract_shape(client):
    r = client.post("/v1/portraits/generate", json={"prompt": "a person", "seed": 1, "outputDir": "gen"})
    assert r.status_code in (202, 503)
    if r.status_code == 503:
        assert r.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    else:
        contract_check.check_job(r.json())
        client.delete(f"/v1/jobs/{r.json()['jobId']}")


def test_token_required_when_configured(work_dir, monkeypatch):
    from parlante_engine.core import config
    from parlante_engine.server import create_app

    monkeypatch.setenv("AVATAR_ENGINE_TOKEN", "s3cret-token")
    config.reset_settings_cache()
    with TestClient(create_app()) as c:
        assert c.get("/health").status_code == 200                       # health stays open
        r = c.get("/v1/jobs/x")
        assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHENTICATED"
        assert c.get("/v1/jobs/x", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert c.get("/v1/jobs/x", headers={"Authorization": "Bearer s3cret-token"}).status_code == 404


def test_non_loopback_bind_needs_token(work_dir, monkeypatch, capsys):
    from parlante_engine.core import config
    from parlante_engine import server

    assert server.is_loopback("127.0.0.1") and server.is_loopback("::1") and server.is_loopback("localhost")
    assert not server.is_loopback("0.0.0.0") and not server.is_loopback("192.168.1.5")
    monkeypatch.setenv("AVATAR_ENGINE_HOST", "0.0.0.0")
    monkeypatch.delenv("AVATAR_ENGINE_TOKEN", raising=False)
    config.reset_settings_cache()
    assert server.main() == 2
    assert "AVATAR_ENGINE_TOKEN" in capsys.readouterr().err
