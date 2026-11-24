"""Nothing leaves the machine: switch off the usage telemetry of the libraries the engine loads.

MUST run before any of them is imported — `parlante_engine/__init__.py` calls `harden()` first
thing, so every entry point (server, scripts, tests) is covered by importing the package.

What was measured on this engine before the switches existed (child process with an empty HOME
and every proxy variable pointing at a local sink; `tests/test_privacy.py` repeats it):

  onnxruntime 1.32   official wheels ship the 1DS telemetry client turned ON, on Linux too.
                     Creating one session wrote ~/.cache/Microsoft/DeveloperTools/.onnxruntime/
                     {deviceid, onnxruntime.db} (a persistent device id and an event queue) and
                     opened `CONNECT mobile.events.data.microsoft.com:443` within 20 s.
                     `ORT_DISABLE_TELEMETRY=1` (read once, when the library initialises) prevents
                     the uploader, the events and the device id from being created.
  openvino 2026.4    `import openvino` alone (it imports its model-conversion tools, which use the
                     separate `openvino_telemetry` package) wrote ~/intel/{openvino_ga_cid, stats}
                     (a client id) and opened `CONNECT www.google-analytics.com:443`. That package
                     is installed as a dependency of the wheel, so it is made unimportable here:
                     OpenVINO then falls back to its own no-op stub (`telemetry_stub`).
  huggingface_hub    installed only as a dependency of `tokenizers`; never called (weights are
                     fetched by our own verified downloader, explicitly, at set-up time). Put in
                     offline mode with its telemetry off in case a dependency ever reaches it.

With the switches: no connection, nothing written to the home directory (same measurement).
"""
from __future__ import annotations

import os
import sys

#: Environment switches forced on (an inherited "0" must not re-enable anything).
ENV = {
    "ORT_DISABLE_TELEMETRY": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "HF_HUB_OFFLINE": "1",
    "DO_NOT_TRACK": "1",
}
#: Python packages that only exist to report usage: importing them raises ImportError.
BLOCKED_MODULES = ("openvino_telemetry",)
#: Libraries whose import reads the switches above: hardening after them is too late.
SENSITIVE_MODULES = ("onnxruntime", "openvino")


def harden() -> list[str]:
    """Apply every switch. Returns the names of sensitive libraries that were ALREADY imported
    (the caller imported them before the engine: their telemetry may have started)."""
    late = [name for name in SENSITIVE_MODULES if name in sys.modules]
    for key, value in ENV.items():
        os.environ[key] = value
    for name in BLOCKED_MODULES:
        # `None` in sys.modules makes `import name` raise ImportError (documented behaviour).
        sys.modules[name] = None  # type: ignore[assignment]
    return late


def status() -> dict:
    """What `/health` and the self-test report: every switch as it is right now."""
    return {
        "onnxruntimeTelemetryDisabled": os.environ.get("ORT_DISABLE_TELEMETRY") == "1",
        "openvinoTelemetryBlocked": all(sys.modules.get(name, 0) is None for name in BLOCKED_MODULES),
        "huggingFaceHubOffline": os.environ.get("HF_HUB_OFFLINE") == "1",
        "hardenedBeforeLibraries": not _LATE,
    }


_LATE: list[str] = []


def harden_at_import() -> None:
    _LATE.extend(harden())
    if _LATE:
        import warnings

        warnings.warn(
            "parlante_engine was imported after " + ", ".join(_LATE) + ": their usage telemetry could not be "
            "switched off in time. Import parlante_engine first.", RuntimeWarning, stacklevel=3)
