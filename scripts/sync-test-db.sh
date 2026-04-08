#!/usr/bin/env bash
# =============================================================================
# sync-test-db.sh — Copy prod DB (jlc) into the test DB (jlc_test)
#
# DANGEROUS: this DROPS jlc_test and recreates it from a live pg_dump of the
# prod jlc database. All data currently in jlc_test will be lost.
#
# Requires CONFIRM=yes to proceed.
#
# Usage:
#   CONFIRM=yes ./scripts/sync-test-db.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ---------------------------------------------------------------------------
# Helpers (match setup.sh style)
# ---------------------------------------------------------------------------
info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m    $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
err()   { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Big loud warning + CONFIRM=yes gate
# ---------------------------------------------------------------------------
cat <<'BANNER'
-------------------------------------------------------------------------------
                          !!! DANGEROUS OPERATION !!!
-------------------------------------------------------------------------------
  This script will:
    1. DROP the existing jlc_test database (all data will be lost)
    2. Recreate jlc_test from a live pg_dump of the prod jlc database
    3. Copy ~446k+ parts and their associated rows

  The prod jlc database is read-only for this operation, but the copy can
  take several minutes and will put extra load on the shared PostgreSQL
  instance. Active test-stack clients will see errors during the sync.

  To proceed, re-run with CONFIRM=yes :
      CONFIRM=yes ./scripts/sync-test-db.sh
-------------------------------------------------------------------------------
BANNER

if [ "${CONFIRM:-}" != "yes" ]; then
  err "CONFIRM=yes not set — aborting."
fi

# ---------------------------------------------------------------------------
# 2. Load .env
# ---------------------------------------------------------------------------
if [ ! -f "$PROJECT_DIR/.env" ]; then
  err ".env not found in $PROJECT_DIR — run ./setup.sh first."
fi

set -a
# shellcheck disable=SC1091
source "$PROJECT_DIR/.env"
set +a

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set in .env}"

SRC_DB="jlc"
DST_DB="jlc_test"
DB_OWNER="jlc"
TEST_PROJECT="jlc-search-test"
TEST_COMPOSE_FILE="docker-compose.test.yml"

# ---------------------------------------------------------------------------
# 3. Ensure the PostgreSQL container is running
# ---------------------------------------------------------------------------
info "Checking that the PostgreSQL container is running..."
if ! docker compose ps --status running db 2>/dev/null | grep -q db; then
  err "db container is not running. Start it first: docker compose up -d db"
fi
ok "PostgreSQL container is running."

# ---------------------------------------------------------------------------
# 4. Stop the test backend(s) so they don't hold connections to jlc_test
#    while we drop and recreate it.
# ---------------------------------------------------------------------------
TEST_BACKEND_WAS_UP=false
if [ -f "$PROJECT_DIR/$TEST_COMPOSE_FILE" ]; then
  if docker compose -p "$TEST_PROJECT" -f "$TEST_COMPOSE_FILE" ps --status running 2>/dev/null \
     | grep -qE 'backend-test|mcp-server-test'; then
    TEST_BACKEND_WAS_UP=true
    info "Stopping test backend/mcp containers to release jlc_test connections..."
    docker compose -p "$TEST_PROJECT" -f "$TEST_COMPOSE_FILE" stop backend-test mcp-server-test 2>/dev/null || true
    ok "Test backend/mcp stopped."
  fi
fi

# ---------------------------------------------------------------------------
# 5. Force-disconnect any remaining clients on jlc_test and drop it
# ---------------------------------------------------------------------------
START_EPOCH=$(date +%s)

info "Terminating any remaining connections to '$DST_DB'..."
docker compose exec -T db psql -U jlc -d postgres <<SQL >/dev/null
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$DST_DB' AND pid <> pg_backend_pid();
SQL
ok "Connections terminated (if any)."

info "Dropping '$DST_DB' (if exists)..."
docker compose exec -T db psql -U jlc -d postgres \
  -c "DROP DATABASE IF EXISTS $DST_DB;" >/dev/null \
  || err "Failed to drop '$DST_DB'."
ok "'$DST_DB' dropped."

info "Recreating '$DST_DB' (owner: $DB_OWNER)..."
docker compose exec -T db psql -U jlc -d postgres \
  -c "CREATE DATABASE $DST_DB OWNER $DB_OWNER;" >/dev/null \
  || err "Failed to create '$DST_DB'."
ok "'$DST_DB' created."

# ---------------------------------------------------------------------------
# 6. pg_dump | psql pipeline inside the same container. Both `exec -T`
#    invocations share this shell's stdin/stdout — the shell pipe on the
#    host carries bytes from pg_dump to psql. -T disables TTY allocation
#    (required for piping).
# ---------------------------------------------------------------------------
info "Copying '$SRC_DB' -> '$DST_DB' via pg_dump | psql (this may take a while)..."
set +e
docker compose exec -T db pg_dump -U jlc -d "$SRC_DB" \
  | docker compose exec -T db psql -U jlc -d "$DST_DB" -q -v ON_ERROR_STOP=1 >/dev/null
PIPE_STATUS=("${PIPESTATUS[@]}")
set -e
if [ "${PIPE_STATUS[0]}" -ne 0 ] || [ "${PIPE_STATUS[1]}" -ne 0 ]; then
  err "pg_dump|psql pipeline failed (pg_dump=${PIPE_STATUS[0]}, psql=${PIPE_STATUS[1]}). '$DST_DB' may be in a partial state."
fi
ok "Data copied into '$DST_DB'."

# ---------------------------------------------------------------------------
# 7. Quick sanity check: count parts in each DB
# ---------------------------------------------------------------------------
info "Running sanity check (row counts)..."
SRC_COUNT=$(docker compose exec -T db psql -U jlc -d "$SRC_DB" -tAc "SELECT count(*) FROM parts;" 2>/dev/null | tr -d '[:space:]' || echo "?")
DST_COUNT=$(docker compose exec -T db psql -U jlc -d "$DST_DB" -tAc "SELECT count(*) FROM parts;" 2>/dev/null | tr -d '[:space:]' || echo "?")
echo "    $SRC_DB.parts = $SRC_COUNT"
echo "    $DST_DB.parts = $DST_COUNT"
if [ "$SRC_COUNT" != "$DST_COUNT" ] || [ "$DST_COUNT" = "0" ]; then
  warn "Row counts differ or destination is empty — please investigate."
else
  ok "Row counts match."
fi

# ---------------------------------------------------------------------------
# 8. Restart test backend if we stopped it earlier
# ---------------------------------------------------------------------------
if [ "$TEST_BACKEND_WAS_UP" = "true" ]; then
  info "Restarting test backend/mcp containers..."
  docker compose -p "$TEST_PROJECT" -f "$TEST_COMPOSE_FILE" start backend-test mcp-server-test 2>/dev/null || true
  ok "Test backend/mcp restarted."
fi

# ---------------------------------------------------------------------------
# 9. Done
# ---------------------------------------------------------------------------
END_EPOCH=$(date +%s)
ELAPSED=$(( END_EPOCH - START_EPOCH ))
ELAPSED_MIN=$(( ELAPSED / 60 ))
ELAPSED_SEC=$(( ELAPSED % 60 ))

echo ""
ok "sync-test-db complete in ${ELAPSED_MIN}m ${ELAPSED_SEC}s."
echo "    Source:      $SRC_DB ($SRC_COUNT rows)"
echo "    Destination: $DST_DB ($DST_COUNT rows)"
echo ""
