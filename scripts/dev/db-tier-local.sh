#!/usr/bin/env bash
# The database tier (jest.db.config.ts) on a disposable Postgres 17 container
# for the current worktree, behind the heavy lock. Never touches a shared
# database: the URL it builds must be @localhost:<port>/ci.
# Usage: scripts/dev/db-tier-local.sh [--log-statements] <log-file> [jest args...]
# --log-statements runs Postgres with log_statement=all and writes the
# statements jest issued to <log-file>.statements; exit 3 when jest passed but
# the count is unavailable (no log, no marker, no statements).
set -u

LOG_STATEMENTS=false
if [[ "${1:-}" == "--log-statements" ]]; then
  LOG_STATEMENTS=true
  shift
fi
if [[ "$#" -lt 1 ]]; then
  echo "usage: $0 [--log-statements] <log-file> [jest args...]" >&2
  exit 2
fi
LOG_ARG="$1"
shift

ROOT="$(git rev-parse --show-toplevel)" || exit 2
mkdir -p "$(dirname "$LOG_ARG")" || exit 2
LOG_FILE="$(cd "$(dirname "$LOG_ARG")" && pwd)/$(basename "$LOG_ARG")"
STATEMENTS_FILE="$LOG_FILE.statements"
cd "$ROOT" || exit 2

# Everything goes to the log; fd 3 keeps the caller's stdout for the summary.
exec 3>&1 >"$LOG_FILE" 2>&1

die() {
  echo "ABORT: $*"
  echo "ABORT: $* (log: $LOG_FILE)" >&3
  exit 1
}

# The installed binaries only: npx could fetch and run a package on demand.
BIN=node_modules/.bin
for tool in prisma jest; do
  [[ -x "$BIN/$tool" ]] || die "missing $BIN/$tool: install or link node_modules in $ROOT first"
done
command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"

NAME="fw-dbtier-$$-$(date +%s)"
WORK="$(mktemp -d)"
LOCK="${FW_HEAVY_LOCK:-/tmp/fw-heavy.lock}"
HAVE_LOCK=false

# The container with its data volume, the scratch directory and the lock go on every exit.
trap 'docker rm -fv "$NAME" >/dev/null 2>&1; rm -rf "$WORK"; if [[ "$HAVE_LOCK" == true ]]; then rmdir "$LOCK"; fi' EXIT
trap 'exit 130' INT TERM HUP

# The heavy lock, as model-orchestration.md section 6b defines it.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "waiting for $LOCK"
  until mkdir "$LOCK" 2>/dev/null; do sleep 15; done
fi
HAVE_LOCK=true

HEAD_START="$(git rev-parse --short HEAD)"
echo "head start: $HEAD_START"
START=$SECONDS

PG_ARGS=()
if [[ "$LOG_STATEMENTS" == true ]]; then PG_ARGS=(-c log_statement=all); fi
# An empty host port makes Docker pick a free one, so two runs never collide.
docker run -d --name "$NAME" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ci \
  postgres:17 "${PG_ARGS[@]+"${PG_ARGS[@]}"}" >/dev/null ||
  die "docker run failed"

PORT="$(docker port "$NAME" 5432/tcp | head -n 1)"
PORT="${PORT##*:}"
case "$PORT" in
  '' | *[!0-9]*) die "could not read the container's port" ;;
  *) ;;
esac

READY=false
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d ci >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done
[[ "$READY" == true ]] || die "Postgres did not become ready in 60 s"

# Blank every key the worktree's .env files name, so next/jest and
# prisma.config.ts cannot load a live credential, then point at the container.
# Keys come from dotenv's own parser, the grammar next/jest loads; values are
# never read out. Templates are never loaded, and a blank would defeat
# jest.setup.ts's `??=`.
ENV_FILES=()
for f in .env*; do
  [[ -f "$f" ]] || continue
  case "$f" in
    *.sample | *.example | *.template) continue ;;
    *) ENV_FILES+=("$f") ;;
  esac
done
if [[ "${#ENV_FILES[@]}" -gt 0 ]]; then
  [[ -f node_modules/dotenv/package.json ]] || die "missing node_modules/dotenv: install or link node_modules in $ROOT first"
  KEYS="$(node -e '
    const fs = require("fs");
    const dotenv = require("dotenv");
    for (const file of process.argv.slice(1)) {
      for (const key of Object.keys(dotenv.parse(fs.readFileSync(file)))) console.log(key);
    }
  ' "${ENV_FILES[@]}")" || die "could not parse ${ENV_FILES[*]} with dotenv"
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      die "cannot blank the .env key '$key': not a shell variable name"
    case "$key" in
      PATH | HOME | USER | SHELL | TMPDIR | PWD) continue ;;
      *) ;;
    esac
    export "$key="
  done <<<"$KEYS"
fi
export CI=true
export BETTER_AUTH_SECRET=dummy-secret-for-local-db-tier-0123456789abcdef
export DATABASE_URL="postgresql://postgres:postgres@localhost:$PORT/ci"
export DIRECT_URL="$DATABASE_URL"

for url in "$DATABASE_URL" "$DIRECT_URL"; do
  case "$url" in
    *@localhost:*/ci) ;;
    *) die "refusing a database URL that is not @localhost:<port>/ci" ;;
  esac
done
echo "target: host=localhost port=$PORT database=ci container=$NAME"

psql_file() { # psql_file <sql-file>
  local sql_file="$1"
  docker exec -i "$NAME" psql -U postgres -d ci -v ON_ERROR_STOP=1 -q <"$sql_file" >/dev/null
}

"$BIN/prisma" migrate diff --from-empty --to-schema prisma/schema.prisma --script \
  >"$WORK/schema.sql" || die "prisma migrate diff failed"
psql_file "$WORK/schema.sql" || die "schema load failed"
echo "schema loaded"
for sidecar in check-constraints ledger-triggers payment-legs-triggers analytics-views; do
  psql_file "prisma/sql/$sidecar.sql" || die "sidecar $sidecar.sql failed to load"
  echo "sidecar loaded: $sidecar"
done

MARKER=fw-dbtier-jest-start
if [[ "$LOG_STATEMENTS" == true ]]; then
  docker exec "$NAME" psql -U postgres -d ci -q -c "SELECT '$MARKER'" >/dev/null ||
    die "could not write the statement-log marker"
fi

"$BIN/jest" -c jest.db.config.ts --maxWorkers=1 --coverage=false "$@"
JEST_RC=$?

# A measurement is a count read from the log after the marker; anything else is
# UNAVAILABLE, never zero.
STATEMENTS_NOTE=""
if [[ "$LOG_STATEMENTS" == true ]]; then
  rm -f "$STATEMENTS_FILE"
  if ! docker logs "$NAME" >"$WORK/postgres.log" 2>&1; then
    STATEMENTS_NOTE="UNAVAILABLE (docker logs failed)"
  elif ! grep -q "$MARKER" "$WORK/postgres.log"; then
    STATEMENTS_NOTE="UNAVAILABLE (start marker not in the log)"
  else
    # One line per statement after the marker; parameter DETAIL lines are dropped.
    sed -n "/$MARKER/,\$p" "$WORK/postgres.log" |
      grep -E 'LOG:  (statement|execute [^:]*): ' |
      grep -v "$MARKER" >"$STATEMENTS_FILE"
    COUNT="$(wc -l <"$STATEMENTS_FILE" | tr -d ' ')"
    if [[ "$COUNT" -gt 0 ]]; then
      STATEMENTS_NOTE="$COUNT in $STATEMENTS_FILE"
    else
      rm -f "$STATEMENTS_FILE"
      STATEMENTS_NOTE="UNAVAILABLE (no statements after the marker)"
    fi
  fi
  echo "statements: $STATEMENTS_NOTE"
fi

HEAD_END="$(git rev-parse --short HEAD)"
echo "jest rc: $JEST_RC"
echo "wall seconds: $((SECONDS - START))"
echo "head end: $HEAD_END"

{
  echo "head start: $HEAD_START"
  grep -E '^(Test Suites|Tests):' "$LOG_FILE"
  echo "jest rc: $JEST_RC"
  if [[ "$LOG_STATEMENTS" == true ]]; then echo "statements: $STATEMENTS_NOTE"; fi
  echo "head end: $HEAD_END"
  echo "log: $LOG_FILE"
} >&3
# Exit 3: jest passed but the statement measurement is unavailable.
if [[ "$JEST_RC" -eq 0 && "$STATEMENTS_NOTE" == UNAVAILABLE* ]]; then exit 3; fi
exit "$JEST_RC"
