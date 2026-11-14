#!/usr/bin/env bash
# Start PostgreSQL and Redis locally WITHOUT Docker and make sure the `parlante` role and the
# `parlante` / `parlante_test` databases exist. Idempotent: safe to run as often as you like.
#
#   pnpm services
#
# On a machine with Docker you can use `docker compose up -d postgres redis` instead.
# Environment overrides: PGPORT (5432), REDIS_PORT (6379), PARLANTE_DB_USER, PARLANTE_DB_PASSWORD.
set -euo pipefail

PGPORT="${PGPORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
DB_USER="${PARLANTE_DB_USER:-parlante}"
DB_PASSWORD="${PARLANTE_DB_PASSWORD:-parlante}"

log() { printf '[services] %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Run a command as the postgres superuser, whatever the current user is.
as_postgres() {
  if [ "$(id -un)" = "postgres" ]; then
    "$@"
  elif [ "$(id -u)" = "0" ]; then
    su postgres -s /bin/sh -c "$(printf '%q ' "$@")"
  elif have sudo && sudo -n true 2>/dev/null; then
    sudo -u postgres "$@"
  else
    # Homebrew / user-owned clusters: the current user is the superuser.
    "$@"
  fi
}

pg_ready() {
  if have pg_isready; then
    pg_isready -q -h localhost -p "$PGPORT"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PGPORT") 2>/dev/null
  fi
}

start_postgres() {
  if pg_ready; then
    log "PostgreSQL already running on port $PGPORT"
    return
  fi
  log "Starting PostgreSQL…"
  if have service && service postgresql status >/dev/null 2>&1 || [ -x /etc/init.d/postgresql ]; then
    if [ "$(id -u)" = "0" ]; then service postgresql start; else sudo service postgresql start; fi
  elif have pg_ctlcluster && have pg_lsclusters; then
    pg_lsclusters -h | while read -r ver name _; do as_postgres pg_ctlcluster "$ver" "$name" start || true; done
  elif have brew; then
    brew services start postgresql@16 || brew services start postgresql
  elif have pg_ctl && [ -n "${PGDATA:-}" ]; then
    pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" start
  else
    log "ERROR: could not find a way to start PostgreSQL. Install PostgreSQL 16 or use Docker."
    exit 1
  fi
  for _ in $(seq 1 30); do
    pg_ready && break
    sleep 1
  done
  pg_ready || { log "ERROR: PostgreSQL did not become ready"; exit 1; }
  log "PostgreSQL is up"
}

redis_ready() {
  have redis-cli && [ "$(redis-cli -p "$REDIS_PORT" ping 2>/dev/null)" = "PONG" ]
}

start_redis() {
  if redis_ready; then
    log "Redis already running on port $REDIS_PORT"
    return
  fi
  log "Starting Redis…"
  if ! have redis-server; then
    log "ERROR: redis-server not found. Install Redis 7 or use Docker."
    exit 1
  fi
  redis-server --port "$REDIS_PORT" --daemonize yes --save '' --appendonly no >/dev/null
  for _ in $(seq 1 15); do
    redis_ready && break
    sleep 1
  done
  redis_ready || { log "ERROR: Redis did not become ready"; exit 1; }
  log "Redis is up"
}

psql_super() {
  as_postgres psql -v ON_ERROR_STOP=1 -p "$PGPORT" -d postgres -tA "$@"
}

ensure_role_and_databases() {
  # Identifiers come from this script's own variables; validate them before inlining.
  case "$DB_USER" in *[!a-z0-9_]*) log "ERROR: invalid PARLANTE_DB_USER"; exit 1 ;; esac
  if [ "$(psql_super -c "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'")" != "1" ]; then
    psql_super -v pw="$DB_PASSWORD" <<SQL >/dev/null
CREATE ROLE "$DB_USER" LOGIN CREATEDB PASSWORD :'pw';
SQL
    log "Created role $DB_USER"
  else
    # CREATEDB lets the test harness create one throw-away database per test run.
    psql_super -c "ALTER ROLE \"$DB_USER\" CREATEDB" >/dev/null
    log "Role $DB_USER exists"
  fi
  for db in parlante parlante_test; do
    if [ "$(psql_super -c "SELECT 1 FROM pg_database WHERE datname = '$db'")" != "1" ]; then
      psql_super -c "CREATE DATABASE \"$db\" OWNER \"$DB_USER\"" >/dev/null
      log "Created database $db"
    else
      log "Database $db exists"
    fi
  done
}

start_postgres
start_redis
ensure_role_and_databases
log "Ready: postgres://$DB_USER:***@localhost:$PGPORT/parlante  ·  redis://localhost:$REDIS_PORT"
