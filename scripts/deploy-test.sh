#!/usr/bin/env bash
# =============================================================================
# deploy-test.sh — Build and (re)start the /test staging stack
#
# Builds and brings up the docker-compose.test.yml stack under the
# `jlc-search-test` compose project. The test stack shares the host PG
# instance on 5432 (db `jlc_test`) and exposes:
#   - backend-test      on port 3011
#   - frontend-test     on port 8081
#   - mcp-server-test   on port 3012
#
# Routing to https://search.the-chipyard.com/test/ is handled by an nginx
# location injected into NPM proxy host #3 — run scripts/enable-test-location.sh
# once per host to configure it.
#
# Usage:
#   ./scripts/deploy-test.sh
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

TEST_PROJECT="jlc-search-test"
TEST_COMPOSE_FILE="docker-compose.test.yml"

if [ ! -f "$PROJECT_DIR/$TEST_COMPOSE_FILE" ]; then
  err "$TEST_COMPOSE_FILE not found in $PROJECT_DIR."
fi

# ---------------------------------------------------------------------------
# 2. Ensure the shared PostgreSQL container is running — the test stack
#    talks to it on localhost:5432 and will fail fast on cold-start if it's
#    not reachable.
# ---------------------------------------------------------------------------
info "Checking that the shared PostgreSQL container is running..."
if ! docker compose ps --status running db 2>/dev/null | grep -q db; then
  warn "The main 'db' container does not appear to be running."
  warn "Start it with: docker compose up -d db"
  warn "Continuing anyway — the test stack will fail to connect until db is up."
fi

# ---------------------------------------------------------------------------
# 3. Build
# ---------------------------------------------------------------------------
info "Building test stack images (project: $TEST_PROJECT)..."
docker compose -p "$TEST_PROJECT" -f "$TEST_COMPOSE_FILE" build \
  || err "Build failed."
ok "Test stack images built."

# ---------------------------------------------------------------------------
# 4. Up
# ---------------------------------------------------------------------------
info "Starting test stack..."
docker compose -p "$TEST_PROJECT" -f "$TEST_COMPOSE_FILE" up -d \
  || err "Failed to bring up test stack."
ok "Test stack started."

# ---------------------------------------------------------------------------
# 5. Status
# ---------------------------------------------------------------------------
echo ""
info "Current test stack status:"
docker compose -p "$TEST_PROJECT" -f "$TEST_COMPOSE_FILE" ps

# ---------------------------------------------------------------------------
# 6. Next steps
# ---------------------------------------------------------------------------
echo ""
ok "deploy-test complete."
echo ""
echo "  Test stack endpoints (direct, bypassing NPM):"
echo "    - Backend API  ........ http://localhost:3011"
echo "    - Frontend     ........ http://localhost:8081"
echo "    - MCP server   ........ http://localhost:3012"
echo ""
echo "  Next steps:"
echo "    1. If you have not already, inject the /test/ nginx location into"
echo "       NPM proxy host #3 (one-time per host):"
echo "         ./scripts/enable-test-location.sh"
echo ""
echo "    2. Smoke test:"
echo "         curl -I https://search.the-chipyard.com/test/"
echo ""
echo "    3. View logs:"
echo "         docker compose -p $TEST_PROJECT -f $TEST_COMPOSE_FILE logs -f"
echo ""
echo "    4. Tear down:"
echo "         docker compose -p $TEST_PROJECT -f $TEST_COMPOSE_FILE down"
echo ""
