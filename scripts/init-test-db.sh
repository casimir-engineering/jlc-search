#!/usr/bin/env bash
# =============================================================================
# init-test-db.sh — Create the jlc_test database for the /test staging stack
#
# Creates database `jlc_test` (owner: jlc) on the live PostgreSQL container
# if it doesn't already exist. Schema is applied by the test backend on
# startup via applySchema(), so if the test backend is already running we
# restart it to trigger schema creation. Otherwise we print a note that
# schema will be applied on first backend start.
#
# Idempotent: safe to re-run.
#
# Usage:
#   ./scripts/init-test-db.sh
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
# 1. Load .env
# ---------------------------------------------------------------------------
if [ ! -f "$PROJECT_DIR/.env" ]; then
  err ".env not found in $PROJECT_DIR — run ./setup.sh first."
fi

set -a
# shellcheck disable=SC1091
source "$PROJECT_DIR/.env"
set +a

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set in .env}"

TEST_DB_NAME="jlc_test"
TEST_DB_OWNER="jlc"
TEST_PROJECT="jlc-search-test"
TEST_COMPOSE_FILE="docker-compose.test.yml"

# ---------------------------------------------------------------------------
# 2. Ensure the main db container is up (that's where the PostgreSQL server
#    lives — both prod and test stacks share the same server instance).
# ---------------------------------------------------------------------------
info "Checking that the PostgreSQL container is running..."
if ! docker compose ps --status running db 2>/dev/null | grep -q db; then
  err "db container is not running. Start it first: docker compose up -d db"
fi
ok "PostgreSQL container is running."

# ---------------------------------------------------------------------------
# 3. Check whether jlc_test already exists
# ---------------------------------------------------------------------------
info "Checking whether database '$TEST_DB_NAME' exists..."
EXISTS=$(docker compose exec -T db psql -U jlc -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$TEST_DB_NAME';" 2>/dev/null | tr -d '[:space:]')

if [ "$EXISTS" = "1" ]; then
  ok "Database '$TEST_DB_NAME' already exists — nothing to create."
  DB_CREATED=false
else
  info "Database '$TEST_DB_NAME' does not exist. Creating..."
  docker compose exec -T db psql -U jlc -d postgres \
    -c "CREATE DATABASE $TEST_DB_NAME OWNER $TEST_DB_OWNER;" \
    || err "Failed to create database '$TEST_DB_NAME'."
  ok "Database '$TEST_DB_NAME' created (owner: $TEST_DB_OWNER)."
  DB_CREATED=true
fi

# ---------------------------------------------------------------------------
# 4. Ensure pg_trgm extension exists in the new database. Extensions are
#    per-database and the backend's applySchema() also creates it, but we
#    create it up front so the DB is ready even before the test stack boots.
# ---------------------------------------------------------------------------
info "Ensuring pg_trgm extension exists in '$TEST_DB_NAME'..."
docker compose exec -T db psql -U jlc -d "$TEST_DB_NAME" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null \
  || err "Failed to ensure pg_trgm in '$TEST_DB_NAME'."
ok "pg_trgm ready in '$TEST_DB_NAME'."

# ---------------------------------------------------------------------------
# 5. If we just created the DB, trigger schema apply by restarting the test
#    backend (it runs applySchema() on startup). If the test backend isn't
#    running yet, just note that it will apply on first start.
# ---------------------------------------------------------------------------
if [ "$DB_CREATED" = "true" ]; then
  if [ ! -f "$PROJECT_DIR/$TEST_COMPOSE_FILE" ]; then
    warn "$TEST_COMPOSE_FILE not found — skipping backend restart."
    info "Schema will be applied on first start of the test backend."
  elif docker compose -p "$TEST_PROJECT" -f "$TEST_COMPOSE_FILE" ps --status running 2>/dev/null \
       | grep -q 'backend-test'; then
    info "Restarting backend-test to trigger schema apply..."
    docker compose -p "$TEST_PROJECT" -f "$TEST_COMPOSE_FILE" restart backend-test \
      || err "Failed to restart backend-test."
    ok "backend-test restarted — schema should now be applied."
  else
    info "Test backend is not running yet."
    info "Schema will be applied automatically on first start of backend-test"
    info "(run scripts/deploy-test.sh to start the test stack)."
  fi
else
  info "Database already existed; leaving schema untouched."
fi

# ---------------------------------------------------------------------------
# 6. Summary
# ---------------------------------------------------------------------------
echo ""
ok "init-test-db complete."
echo "    Database:      $TEST_DB_NAME"
echo "    Owner:         $TEST_DB_OWNER"
echo "    Host:          localhost:5432 (same PG instance as prod)"
echo ""
echo "  Next steps:"
echo "    1. Deploy the test stack:    ./scripts/deploy-test.sh"
echo "    2. Enable the /test NPM loc: ./scripts/enable-test-location.sh"
echo ""
