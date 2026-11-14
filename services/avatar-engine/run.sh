#!/usr/bin/env bash
# Start the Parlante avatar engine: creates the virtualenv, installs the pinned requirements,
# downloads missing weights (sha256-verified) and launches the HTTP server.
#   bash services/avatar-engine/run.sh            # start (default http://127.0.0.1:8090)
#   bash services/avatar-engine/run.sh --setup    # install + download only, do not start
# Environment (see README.md): AVATAR_ENGINE_URL, AVATAR_ENGINE_WORK_DIR, AVATAR_ENGINE_MODELS_DIR,
# AVATAR_ENGINE_THREADS, AVATAR_ENGINE_SKIP_DOWNLOAD=1, AVATAR_ENGINE_DOWNLOAD_ARGS="--with-audio".
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Load the repo's .env (if any) without overriding variables that are already set.
ENV_FILE="../../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    case "$key" in AVATAR_ENGINE_*|FFMPEG_PATH|HF_HOME) ;; *) continue ;; esac
    value="${value%%#*}"; value="$(printf '%s' "$value" | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/')"
    if [ -z "${!key:-}" ] && [ -n "$value" ]; then export "$key=$value"; fi
  done < "$ENV_FILE"
fi

PYTHON_BIN="${AVATAR_ENGINE_PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "avatar-engine: python3 (3.11+) is required" >&2; exit 1
fi
if ! command -v "${FFMPEG_PATH:-ffmpeg}" >/dev/null 2>&1; then
  echo "avatar-engine: ffmpeg is required (install it or set FFMPEG_PATH)" >&2; exit 1
fi

VENV=".venv"
STAMP="$VENV/.requirements.sha256"
if [ ! -x "$VENV/bin/python" ]; then
  echo "avatar-engine: creating virtualenv in services/avatar-engine/$VENV"
  "$PYTHON_BIN" -m venv "$VENV"
fi
WANT="$(sha256sum requirements.txt | cut -d' ' -f1)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$WANT" ]; then
  echo "avatar-engine: installing pinned requirements"
  "$VENV/bin/python" -m pip install --disable-pip-version-check -q -r requirements.txt
  echo "$WANT" > "$STAMP"
fi

if [ "${AVATAR_ENGINE_SKIP_DOWNLOAD:-0}" != "1" ]; then
  # shellcheck disable=SC2086
  "$VENV/bin/python" scripts/download_models.py ${AVATAR_ENGINE_DOWNLOAD_ARGS:-}
fi

if [ "${1:-}" = "--setup" ]; then
  echo "avatar-engine: setup complete"; exit 0
fi
exec "$VENV/bin/python" -m parlante_engine
