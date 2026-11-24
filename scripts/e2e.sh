#!/usr/bin/env bash
# End-to-end runner: a brand-new database, the real API, the real worker and the real web app,
# all started together on configurable ports; then every script passed as an argument runs
# against them. Everything it started or created is stopped and removed on exit — also when a
# script fails or the run is interrupted.
#
#   bash scripts/e2e.sh e2e/core.mjs            (= pnpm e2e e2e/core.mjs)
#   E2E_WEB_MODE=dev bash scripts/e2e.sh e2e/core.mjs e2e/ai.mjs
#
# Environment overrides:
#   E2E_API_PORT   port of the API                         (default 4211)
#   E2E_WEB_PORT   port of the web app                     (default 5211)
#   E2E_HOOK_PORT  port the scripts may bind for a local webhook receiver (default API port + 50)
#   E2E_WEB_MODE   build (default: production bundle served by `vite preview`, no file watching)
#                  | dev (Vite dev server: quicker to start, reloads when files change)
#   E2E_KEEP       1 = keep database, storage and logs after the run (debugging)
#   E2E_RUN_ID     suffix of the database / queue prefix / work directory (default: random)
#   E2E_WORK_DIR   where logs, storage and artifacts go    (default: $TMPDIR/parlante-e2e-<id>)
#   DATABASE_ADMIN_URL  maintenance connection used to create / drop the database
#                  (default postgres://parlante:parlante@localhost:5432/postgres)
#
# What the scripts receive: E2E_WEB_URL, E2E_API_URL, E2E_HOOK_PORT, E2E_DATABASE_URL,
# E2E_ARTIFACTS_DIR (screenshots, downloaded files, extracted frames) and E2E_RUN_ID.
#
# The stack runs with NODE_ENV=development and ALLOW_PRIVATE_URLS=true so a webhook can be
# delivered to a receiver on 127.0.0.1. That switch is off by default and refused in production.
# E2E_ALLOW_PRIVATE_URLS=false keeps the product default instead: e2e/ai.mjs needs it to check
# that "URL → script" refuses non-public destinations (SSRF guard).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/e2e.sh <script.mjs> [more scripts…]" >&2
  exit 2
fi
for script in "$@"; do
  [ -f "$script" ] || { echo "[e2e] script not found: $script" >&2; exit 2; }
done

API_PORT="${E2E_API_PORT:-4211}"
WEB_PORT="${E2E_WEB_PORT:-5211}"
HOOK_PORT="${E2E_HOOK_PORT:-$((API_PORT + 50))}"
WEB_MODE="${E2E_WEB_MODE:-build}"
RUN_ID="${E2E_RUN_ID:-$(date +%H%M%S)$(printf '%04x' "$RANDOM")}"
RUN_ID="$(printf '%s' "$RUN_ID" | tr -c 'a-z0-9' '_')"
WORK_DIR="${E2E_WORK_DIR:-${TMPDIR:-/tmp}/parlante-e2e-$RUN_ID}"
ADMIN_URL="${DATABASE_ADMIN_URL:-postgres://parlante:parlante@localhost:5432/postgres}"
DB_NAME="parlante_e2e_$RUN_ID"
DB_URL="${ADMIN_URL%/*}/$DB_NAME"
QUEUE_PREFIX_E2E="parlante-e2e-$RUN_ID"
REDIS_URL_E2E="${REDIS_URL:-redis://localhost:6379}"
API_URL="http://127.0.0.1:$API_PORT"
WEB_URL="http://127.0.0.1:$WEB_PORT"

log() { printf '[e2e] %s\n' "$*"; }

PIDS=()
DB_CREATED=0
STATUS=1

# Run a tiny script with the `pg` / `ioredis` clients the workspace already depends on.
node_in() { # <package dir> <inline script> [args…]
  local dir="$1" code="$2"
  shift 2
  (cd "$ROOT/$dir" && node --input-type=module -e "$code" -- "$@")
}

admin_sql() {
  node_in packages/db '
    import pg from "pg";
    const [url, sql] = process.argv.slice(1);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try { await client.query(sql); } finally { await client.end(); }
  ' "$ADMIN_URL" "$1"
}

drop_queue_keys() {
  node_in packages/jobs '
    import { Redis } from "ioredis";
    const [url, prefix] = process.argv.slice(1);
    const redis = new Redis(url, { maxRetriesPerRequest: 2 });
    let cursor = "0", removed = 0;
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", prefix + ":*", "COUNT", 500);
      cursor = next;
      if (keys.length > 0) removed += await redis.del(...keys);
    } while (cursor !== "0");
    await redis.quit();
    console.log(String(removed));
  ' "$REDIS_URL_E2E" "$QUEUE_PREFIX_E2E"
}

stop_group() { # <pid of a `setsid` child = its process group id>
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  set +e
  log "stopping servers…"
  for pid in "${PIDS[@]}"; do stop_group "$pid"; done
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    log "E2E_KEEP=1 — kept database $DB_NAME, queue prefix $QUEUE_PREFIX_E2E and $WORK_DIR"
  else
    if [ "$DB_CREATED" = "1" ]; then
      admin_sql "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" && log "dropped database $DB_NAME"
    fi
    removed="$(drop_queue_keys 2>/dev/null)" && log "removed ${removed:-0} Redis keys ($QUEUE_PREFIX_E2E:*)"
    if [ "$STATUS" = "0" ]; then
      rm -rf "$WORK_DIR"
    else
      # Keep what explains a failure (logs, screenshots); drop the bulky parts.
      rm -rf "$WORK_DIR/storage" "$WORK_DIR/tmp" "$WORK_DIR/web-dist" "$WORK_DIR/engine"
      log "logs and artifacts of the failed run: $WORK_DIR"
    fi
  fi
  exit "$STATUS"
}
trap cleanup EXIT
trap 'STATUS=130; exit 130' INT TERM

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_http() { # <name> <url> <pid> <seconds>
  local name="$1" url="$2" pid="$3" limit="$4"
  for _ in $(seq 1 "$limit"); do
    if curl --noproxy '*' -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      log "$name is up ($url)"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || { log "ERROR: $name exited while starting"; return 1; }
    sleep 1
  done
  log "ERROR: $name did not answer on $url within ${limit}s"
  return 1
}

wait_log() { # <name> <file> <pattern> <pid> <seconds>
  local name="$1" file="$2" pattern="$3" pid="$4" limit="$5"
  for _ in $(seq 1 "$limit"); do
    if grep -q "$pattern" "$file" 2>/dev/null; then
      log "$name is up"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || { log "ERROR: $name exited while starting"; return 1; }
    sleep 1
  done
  log "ERROR: $name did not report ready within ${limit}s"
  return 1
}

start() { # <log file> <dir> <command…>  — own session, so the whole tree can be stopped
  local logfile="$1" dir="$2"
  shift 2
  (cd "$ROOT/$dir" && exec setsid "$@" >"$logfile" 2>&1) &
  PIDS+=("$!")
}

fail_with_log() { # <log file>
  log "---- last lines of $1"
  tail -n 40 "$1" >&2 || true
  exit 1
}

# ------------------------------------------------------------------ preparation
for port in "$API_PORT" "$WEB_PORT" "$HOOK_PORT"; do
  port_free "$port" || { log "ERROR: port $port is already in use"; exit 1; }
done

mkdir -p "$WORK_DIR"/{logs,storage,tmp,artifacts,engine}
log "run $RUN_ID — work dir $WORK_DIR"

bash scripts/dev-services.sh >"$WORK_DIR/logs/services.log" 2>&1 || fail_with_log "$WORK_DIR/logs/services.log"

admin_sql "CREATE DATABASE \"$DB_NAME\""
DB_CREATED=1
log "created database $DB_NAME"

# Everything the three processes need; nothing is read from a developer's .env by accident
# for the values that isolate this run.
export NODE_ENV=development
export LOG_LEVEL="${E2E_LOG_LEVEL:-info}"
export DATABASE_URL="$DB_URL"
export REDIS_URL="$REDIS_URL_E2E"
export QUEUE_PREFIX="$QUEUE_PREFIX_E2E"
export PUBLIC_API_URL="$API_URL"
export PUBLIC_WEB_URL="$WEB_URL"
export WEB_ORIGIN="$WEB_URL,http://localhost:$WEB_PORT"
export API_HOST=127.0.0.1
export API_PORT
export STORAGE_PROVIDER=local
export STORAGE_LOCAL_DIR="$WORK_DIR/storage"
export UPLOAD_TMP_DIR="$WORK_DIR/tmp"
export WORKER_TMP_DIR="$WORK_DIR/tmp"
export ALLOW_PRIVATE_URLS="${E2E_ALLOW_PRIVATE_URLS:-true}"
export RATE_LIMIT_MAX="${E2E_RATE_LIMIT_MAX:-100000}"
# Local providers only, whatever keys the machine has: the run must not depend on (or spend
# money at) an external service. The neural engine is not started by this runner; scripts that
# need it say so through E2E_AVATAR_ENGINE_URL.
# TTS_PROVIDER=neural is what a fresh installation gets from the default (`auto`) when it has
# no API key: the local neural voices installed on this machine (`pnpm voices:setup`) when
# there are any, eSpeak NG otherwise — and, unlike `auto`, it never prefers an external
# provider whose key happens to be in the environment. The scripts read which voice they got
# from the API. E2E_TTS_PROVIDER=espeak runs the stack on the reserve voice alone.
export TTS_PROVIDER="${E2E_TTS_PROVIDER:-neural}"
export STT_PROVIDER=manual LLM_PROVIDER=local TRANSLATION_PROVIDER=local
export VOICE_CLONE_PROVIDER=local MODERATION_PROVIDER=local
export AVATAR_ENGINE_URL="${E2E_AVATAR_ENGINE_URL:-http://127.0.0.1:9}"
export AVATAR_ENGINE_WORK_DIR="${E2E_AVATAR_ENGINE_WORK_DIR:-$WORK_DIR/engine}"
export VITE_API_PROXY_TARGET="$API_URL"

log "migrating…"
pnpm --silent --filter @parlante/db db:migrate >"$WORK_DIR/logs/migrate.log" 2>&1 || fail_with_log "$WORK_DIR/logs/migrate.log"

# ------------------------------------------------------------------ servers
TSX="$ROOT/node_modules/.bin/tsx"
VITE="$ROOT/apps/web/node_modules/.bin/vite"

start "$WORK_DIR/logs/api.log" apps/api "$TSX" src/server.ts
API_PID="${PIDS[-1]}"
start "$WORK_DIR/logs/worker.log" apps/worker "$TSX" src/main.ts
WORKER_PID="${PIDS[-1]}"

if [ "$WEB_MODE" = "dev" ]; then
  start "$WORK_DIR/logs/web.log" apps/web "$VITE" --host 127.0.0.1 --port "$WEB_PORT" --strictPort
else
  log "building the web app…"
  (cd apps/web && "$VITE" build --outDir "$WORK_DIR/web-dist" --emptyOutDir --logLevel warn) \
    >"$WORK_DIR/logs/web-build.log" 2>&1 || fail_with_log "$WORK_DIR/logs/web-build.log"
  start "$WORK_DIR/logs/web.log" apps/web "$VITE" preview --outDir "$WORK_DIR/web-dist" \
    --host 127.0.0.1 --port "$WEB_PORT" --strictPort
fi
WEB_PID="${PIDS[-1]}"

wait_http "API" "$API_URL/health" "$API_PID" 90 || fail_with_log "$WORK_DIR/logs/api.log"
wait_log "worker" "$WORK_DIR/logs/worker.log" "worker ready" "$WORKER_PID" 90 || fail_with_log "$WORK_DIR/logs/worker.log"
wait_http "web" "$WEB_URL/" "$WEB_PID" 120 || fail_with_log "$WORK_DIR/logs/web.log"

# ------------------------------------------------------------------ scripts
export E2E_WEB_URL="$WEB_URL"
export E2E_API_URL="$API_URL"
export E2E_HOOK_PORT="$HOOK_PORT"
export E2E_DATABASE_URL="$DB_URL"
export E2E_ARTIFACTS_DIR="${E2E_ARTIFACTS_DIR:-$WORK_DIR/artifacts}"
export E2E_RUN_ID="$RUN_ID"
export E2E_WORKER_PID="$WORKER_PID"
export E2E_LOG_DIR="$WORK_DIR/logs"
mkdir -p "$E2E_ARTIFACTS_DIR"

STATUS=0
for script in "$@"; do
  log "▶ $script"
  started="$(date +%s)"
  if node "$script"; then
    log "✔ $script ($(( $(date +%s) - started )) s)"
  else
    code=$?
    log "✘ $script failed (exit $code, $(( $(date +%s) - started )) s)"
    STATUS=1
    for name in api worker web; do
      log "---- last lines of $name.log"
      tail -n 25 "$WORK_DIR/logs/$name.log" >&2 || true
    done
    break
  fi
done

[ "$STATUS" = "0" ] && log "ALL GREEN" || log "FAILED"
exit "$STATUS"
