"""Check that the virtualenv can run the engine: imports, the Perth watermarker, the device.

Exit 0 when it can, 1 otherwise (run.sh repairs and retries once). Prints the device.
"""

from __future__ import annotations

import sys


def main() -> int:
    try:
        # torch and chatterbox BEFORE huggingface_hub / safetensors (see README).
        import torch
        import chatterbox.mtl_tts  # noqa: F401
        import perth
        import transformers  # noqa: F401
        import huggingface_hub  # noqa: F401
        import safetensors  # noqa: F401
        import librosa  # noqa: F401
    except Exception as err:  # noqa: BLE001 - any import failure means "repair"
        print(f"voice-engine: import failed: {err}", file=sys.stderr)
        return 1
    if perth.PerthImplicitWatermarker is None:
        print("voice-engine: the Perth watermarker is unavailable (setuptools<81 missing)", file=sys.stderr)
        return 1
    print(f"voice-engine: environment ok (torch {torch.__version__}, cuda={torch.cuda.is_available()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
