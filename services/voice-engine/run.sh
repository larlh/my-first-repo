#!/usr/bin/env bash
# Start the Parlante voice engine (realistic local voice cloning, Chatterbox es-ES): creates the
# virtualenv, installs the pinned requirements, downloads missing weights (sha256-verified) and
# launches the HTTP server.
#   bash services/voice-engine/run.sh            # start (default http://127.0.0.1:8091)
#   bash services/voice-engine/run.sh --setup    # install + download only, do not start
# Environment (see README.md): VOICE_ENGINE_URL, VOICE_ENGINE_VENV, VOICE_ENGINE_DATA_DIR,
# VOICE_ENGINE_DEVICE (auto|cuda|cpu), VOICE_ENGINE_TOKEN, VOICE_ENGINE_SKIP_DOWNLOAD=1.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Load the repo's .env (if any) without overriding variables that are already set.
ENV_FILE="../../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    case "$key" in VOICE_ENGINE_*|HF_HOME) ;; *) continue ;; esac
    value="${value%%#*}"; value="$(printf '%s' "$value" | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/')"
    if [ -z "${!key:-}" ] && [ -n "$value" ]; then export "$key=$value"; fi
  done < "$ENV_FILE"
fi

PYTHON_BIN="${VOICE_ENGINE_PYTHON:-python3}"
# An existing virtualenv that already runs Chatterbox can be reused (VOICE_ENGINE_VENV);
# by default the engine gets its own in services/voice-engine/.venv.
VENV="${VOICE_ENGINE_VENV:-.venv}"
STAMP="$VENV/.parlante-voice.sha256"
if [ ! -x "$VENV/bin/python" ]; then
  if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "voice-engine: python3 (3.11+) is required" >&2; exit 1
  fi
  echo "voice-engine: creating virtualenv in $VENV"
  "$PYTHON_BIN" -m venv "$VENV"
fi
WANT="$(cat requirements.txt scripts/check_env.py | sha256sum | cut -d' ' -f1)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$WANT" ]; then
  if ! "$VENV/bin/python" scripts/check_env.py 2>/dev/null; then
    echo "voice-engine: installing pinned requirements (PyTorch with CUDA: about 3 GB)"
    "$VENV/bin/python" -m pip install --disable-pip-version-check -q -r requirements.txt
    if ! "$VENV/bin/python" scripts/check_env.py; then
      # Damaged RECORD files of these wheels broke `import transformers` on the reference machine.
      echo "voice-engine: repairing packages with damaged metadata"
      "$VENV/bin/python" -m pip install --disable-pip-version-check -q --force-reinstall --no-deps \
        "nodeenv==1.12.0" "narwhals==2.29.0" "nvidia-cublas-cu12==12.4.5.8"
      "$VENV/bin/python" scripts/check_env.py
    fi
  fi
  echo "$WANT" > "$STAMP"
fi

if [ "${VOICE_ENGINE_SKIP_DOWNLOAD:-0}" != "1" ]; then
  "$VENV/bin/python" scripts/download_models.py
fi

if [ "${1:-}" = "--setup" ]; then
  echo "voice-engine: setup complete"; exit 0
fi
exec "$VENV/bin/python" -m parlante_voice
