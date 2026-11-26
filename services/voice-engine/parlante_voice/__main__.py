"""python -m parlante_voice — start the voice engine (models load in the background)."""

from __future__ import annotations

import logging
import os
import sys

# run.sh has downloaded and verified every weight file: the engine itself never goes online
# (set before huggingface_hub is imported, which reads it once).
os.environ.setdefault("HF_HUB_OFFLINE", "1")

from .config import load_settings
from .engine import ChatterboxEngine
from .server import serve


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s voice-engine %(levelname)s %(message)s")
    settings = load_settings()
    if settings.host not in ("127.0.0.1", "localhost", "::1") and not settings.token:
        print("voice-engine: VOICE_ENGINE_TOKEN is required when not listening on loopback", file=sys.stderr)
        return 1
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    engine = ChatterboxEngine(settings)
    engine.start_loading()
    server = serve(engine, settings.host, settings.port, settings.token)
    logging.getLogger("parlante_voice").info("listening on http://%s:%d", settings.host, settings.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
