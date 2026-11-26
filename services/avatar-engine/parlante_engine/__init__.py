"""Parlante local neural avatar engine (master prompt §2b).

Sub-packages: core (config, model registry, job queue, backends, video), prepare (photo ->
prepared portrait + cached appearance), animate (viseme- and audio-driven talking clips),
portrait / matting (owned by the portrait team, discovered dynamically).
"""

__version__ = "1.0.0"

# Privacy first: the telemetry switches of ONNX Runtime / OpenVINO must be in place before any
# sub-module imports those libraries (see core/privacy.py).
from parlante_engine.core.privacy import harden_at_import as _harden_at_import  # noqa: E402

_harden_at_import()
