"""Privacy watchdog: loading and using the inference libraries through the engine must not open
any outbound connection nor leave an identifier in the user's home directory.

Runs real ONNX Runtime and OpenVINO sessions on a tiny generated model (no weights needed) in
a child process with an EMPTY home directory and every proxy variable pointing at a local sink
that records whoever connects. A negative control runs the same workload WITHOUT the engine's
switches: on onnxruntime builds that ship telemetry it must be caught, which proves the
watchdog can see what it guards against.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

WORKLOAD = r"""
import json, os, sys, time
{prelude}
import numpy as np
import onnx
from onnx import TensorProto, helper

node = helper.make_node("Relu", ["x"], ["y"])
graph = helper.make_graph([node], "tiny", [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 4])],
                          [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 4])])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
model.ir_version = 9
path = os.path.join(sys.argv[1], "tiny.onnx")
onnx.save(model, path)
x = np.array([[-1.0, 0.0, 2.0, 3.0]], np.float32)

import onnxruntime as ort
sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
out_ort = sess.run(None, {{"x": x}})[0].tolist()

import openvino as ov
core = ov.Core()
compiled = core.compile_model(core.read_model(path), "CPU")
out_ov = compiled.create_infer_request().infer({{"x": x}})
out_ov = [v.tolist() for v in out_ov.values()][0]
try:
    import openvino_telemetry  # noqa: F401
    telemetry_importable = True
except ImportError:
    telemetry_importable = False
from openvino.tools.ovc import telemetry_utils
time.sleep({linger})          # give a background uploader the time to show itself
del sess
print(json.dumps({{"ort": out_ort, "ov": out_ov, "telemetryImportable": telemetry_importable,
                  "ovcTelemetry": telemetry_utils.tm.__name__,
                  "ortSwitch": os.environ.get("ORT_DISABLE_TELEMETRY")}}))
"""


class Sink:
    """Accepts TCP connections on loopback and records the first bytes of each (the CONNECT line
    of a proxied HTTPS request names the destination). Never forwards anything."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.seen: list[str] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except (TimeoutError, OSError):
                continue
            try:
                conn.settimeout(1.0)
                first = conn.recv(200).split(b"\r\n", 1)[0].decode("latin-1", "replace")
            except OSError:
                first = "<connection without data>"
            self.seen.append(first)
            conn.close()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
        self.sock.close()


def run_workload(tmp_path: Path, name: str, prelude: str, linger: float) -> dict:
    home = tmp_path / f"home-{name}"
    scratch = tmp_path / f"scratch-{name}"
    home.mkdir()
    scratch.mkdir()
    sink = Sink()
    proxy = f"http://127.0.0.1:{sink.port}"
    env = {k: v for k, v in os.environ.items()
           if k.upper() not in ("ORT_DISABLE_TELEMETRY", "DO_NOT_TRACK", "NO_PROXY", "CI")}
    env.update({"HOME": str(home), "USERPROFILE": str(home), "LOCALAPPDATA": str(home / "AppData"),
                "XDG_CACHE_HOME": str(home / ".cache"), "XDG_CONFIG_HOME": str(home / ".config"),
                "XDG_DATA_HOME": str(home / ".local" / "share"),
                "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ALL_PROXY": proxy,
                "http_proxy": proxy, "https_proxy": proxy, "all_proxy": proxy,
                "PYTHONPATH": str(ROOT), "PYTHONDONTWRITEBYTECODE": "1"})
    try:
        proc = subprocess.run([sys.executable, "-c", WORKLOAD.format(prelude=prelude, linger=linger), str(scratch)],
                              env=env, capture_output=True, text=True, timeout=180, cwd=str(scratch))
    finally:
        sink.close()
    assert proc.returncode == 0, proc.stderr[-2000:]
    written = sorted(str(p.relative_to(home)) for p in home.rglob("*") if p.is_file())
    return {"result": json.loads(proc.stdout.strip().splitlines()[-1]), "connections": sink.seen,
            "homeFiles": written, "stderr": proc.stderr}


def test_harden_sets_every_switch(monkeypatch):
    from parlante_engine.core import privacy

    monkeypatch.setenv("ORT_DISABLE_TELEMETRY", "0")        # an inherited "0" must not survive
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delitem(sys.modules, "openvino_telemetry", raising=False)
    privacy.harden()
    assert os.environ["ORT_DISABLE_TELEMETRY"] == "1"
    assert os.environ["HF_HUB_OFFLINE"] == "1" and os.environ["HF_HUB_DISABLE_TELEMETRY"] == "1"
    with pytest.raises(ImportError):
        import openvino_telemetry  # noqa: F401
    status = privacy.status()
    assert status["onnxruntimeTelemetryDisabled"] and status["openvinoTelemetryBlocked"]


def test_importing_the_engine_hardens_before_the_libraries(tmp_path):
    """A fresh interpreter: `import parlante_engine` alone must leave the switches in place and
    must not have imported the libraries itself."""
    code = ("import os, sys, json; import parlante_engine; "
            "from parlante_engine.core import privacy; "
            "print(json.dumps({'status': privacy.status(), "
            "'loaded': [m for m in ('onnxruntime', 'openvino') if m in sys.modules]}))")
    env = {k: v for k, v in os.environ.items() if k != "ORT_DISABLE_TELEMETRY"}
    env["PYTHONPATH"] = str(ROOT)
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=60,
                         cwd=str(tmp_path))
    assert out.returncode == 0, out.stderr
    data = json.loads(out.stdout)
    assert data["loaded"] == []
    assert data["status"] == {"onnxruntimeTelemetryDisabled": True, "openvinoTelemetryBlocked": True,
                              "huggingFaceHubOffline": True, "hardenedBeforeLibraries": True}


def test_engine_libraries_make_no_connection_and_write_no_identifier(tmp_path):
    guarded = run_workload(tmp_path, "guarded", "import parlante_engine", linger=4.0)
    assert guarded["result"]["ort"] == [[0.0, 0.0, 2.0, 3.0]]         # the libraries really ran
    assert guarded["result"]["ov"] == [[0.0, 0.0, 2.0, 3.0]]
    assert guarded["result"]["ortSwitch"] == "1"
    assert guarded["result"]["telemetryImportable"] is False
    assert guarded["result"]["ovcTelemetry"].endswith("telemetry_stub")
    assert guarded["connections"] == [], f"outbound connection attempted: {guarded['connections']}"
    assert guarded["homeFiles"] == [], f"files written to the home directory: {guarded['homeFiles']}"

    # Negative control: the same workload with the libraries' defaults.
    control = run_workload(tmp_path, "control", "", linger=4.0)
    caught = bool(control["connections"]) or bool(control["homeFiles"])
    if not caught:
        pytest.skip("control run showed no telemetry with this onnxruntime build: the guarded run is clean, "
                    "but this watchdog could not prove it would notice a regression")
    assert control["result"]["ortSwitch"] is None
