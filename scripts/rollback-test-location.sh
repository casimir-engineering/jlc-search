#!/usr/bin/env bash
# =============================================================================
# rollback-test-location.sh — Restore the most recent NPM proxy host #3 backup
#
# Finds the most recent data/npm-backup/proxy-host-3.*.json file (created by
# enable-test-location.sh) and PUTs it back to NPM, effectively undoing
# whatever change the last run of enable-test-location made.
#
# Usage:
#   ./scripts/rollback-test-location.sh
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
# 1. Prereqs
# ---------------------------------------------------------------------------
command -v curl >/dev/null 2>&1 || err "curl is required."
command -v jq   >/dev/null 2>&1 || err "jq is required."

if [ ! -f "$PROJECT_DIR/.env" ]; then
  err ".env not found in $PROJECT_DIR — run ./setup.sh first."
fi

set -a
# shellcheck disable=SC1091
source "$PROJECT_DIR/.env"
set +a

: "${NPM_ADMIN_EMAIL:?NPM_ADMIN_EMAIL not set in .env}"
: "${NPM_ADMIN_PASS:?NPM_ADMIN_PASS not set in .env}"

NPM_URL="http://localhost:81"
HOST_ID=3
BACKUP_DIR="$PROJECT_DIR/data/npm-backup"

# ---------------------------------------------------------------------------
# 2. Find the most recent backup
# ---------------------------------------------------------------------------
if [ ! -d "$BACKUP_DIR" ]; then
  err "Backup directory not found: $BACKUP_DIR (has enable-test-location.sh ever run?)"
fi

# `ls -t` sorts by mtime, newest first. We intentionally restrict to the
# proxy-host-3.*.json pattern written by enable-test-location.sh.
LATEST_BACKUP=$(cd "$BACKUP_DIR" && ls -1t proxy-host-${HOST_ID}.*.json 2>/dev/null | head -1 || true)

if [ -z "$LATEST_BACKUP" ]; then
  err "No backup files matching proxy-host-${HOST_ID}.*.json found in $BACKUP_DIR."
fi

BACKUP_PATH="$BACKUP_DIR/$LATEST_BACKUP"
ok "Using backup: $BACKUP_PATH"

# ---------------------------------------------------------------------------
# 3. Sanity-check the backup file
# ---------------------------------------------------------------------------
if ! jq -e '.id' "$BACKUP_PATH" >/dev/null 2>&1; then
  err "Backup file is not valid JSON or missing .id field: $BACKUP_PATH"
fi

BACKUP_ID=$(jq -r '.id' "$BACKUP_PATH")
if [ "$BACKUP_ID" != "$HOST_ID" ]; then
  err "Backup file id ($BACKUP_ID) does not match expected host id ($HOST_ID)."
fi

BACKUP_DOMAINS=$(jq -r '.domain_names | join(",")' "$BACKUP_PATH")
BACKUP_FWD=$(jq -r '"\(.forward_scheme)://\(.forward_host):\(.forward_port)"' "$BACKUP_PATH")
ok "Backup contents: host #$BACKUP_ID ($BACKUP_DOMAINS) -> $BACKUP_FWD"

# ---------------------------------------------------------------------------
# 4. Authenticate against NPM
# ---------------------------------------------------------------------------
info "Authenticating against NPM at $NPM_URL..."
TOKEN=$(curl -sf "$NPM_URL/api/tokens" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$NPM_ADMIN_EMAIL" --arg secret "$NPM_ADMIN_PASS" \
        '{identity: $id, secret: $secret}')" \
  | jq -r '.token // empty') || TOKEN=""

if [ -z "$TOKEN" ]; then
  err "NPM authentication failed. Check NPM_ADMIN_EMAIL / NPM_ADMIN_PASS in .env."
fi
ok "Authenticated."

npm_get()  { curl -sf -X GET -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$NPM_URL$1"; }
npm_put()  { curl -sf -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2" "$NPM_URL$1"; }

# ---------------------------------------------------------------------------
# 5. Build PUT payload from the backup file using the PUT schema whitelist.
#    NPM's PUT /api/nginx/proxy-hosts/:id has additionalProperties:false and
#    rejects id/created_on/modified_on/owner_user_id/owner/certificate/
#    access_list. Rebuild from scratch with only the allowed keys.
# ---------------------------------------------------------------------------
PAYLOAD=$(jq '
  {
    domain_names,
    forward_scheme,
    forward_host,
    forward_port,
    certificate_id,
    ssl_forced,
    hsts_enabled,
    hsts_subdomains,
    trust_forwarded_proto,
    http2_support,
    block_exploits,
    caching_enabled,
    allow_websocket_upgrade,
    access_list_id,
    advanced_config,
    locations
  }
' "$BACKUP_PATH")

# Save the backup's advanced_config for the post-PUT verification below.
BACKUP_AC=$(jq -r '.advanced_config // ""' "$BACKUP_PATH")

# ---------------------------------------------------------------------------
# 6. PUT it back
# ---------------------------------------------------------------------------
info "Restoring proxy host #$HOST_ID from $LATEST_BACKUP..."
if ! npm_put "/api/nginx/proxy-hosts/$HOST_ID" "$PAYLOAD" >/dev/null; then
  err "PUT /api/nginx/proxy-hosts/$HOST_ID failed. Proxy host state unknown — check NPM admin UI."
fi
ok "PUT succeeded."

# ---------------------------------------------------------------------------
# 7. Verify — make sure the live advanced_config now matches the backup's.
# ---------------------------------------------------------------------------
info "Verifying the restore..."
VERIFY_JSON=$(npm_get "/api/nginx/proxy-hosts/$HOST_ID") \
  || err "Verify GET failed. Check NPM state manually."

LIVE_AC=$(echo "$VERIFY_JSON" | jq -r '.advanced_config // ""')
if [ "$LIVE_AC" = "$BACKUP_AC" ]; then
  ok "Verified: live advanced_config matches backup."
else
  warn "Live advanced_config does not byte-match the backup. Manual review recommended."
  warn "  Backup file: $BACKUP_PATH"
fi

if echo "$LIVE_AC" | grep -q 'location /test/'; then
  warn "Note: restored advanced_config still contains 'location /test/'."
  warn "That means the backup itself already had the /test/ block — rollback"
  warn "to an older backup if you want to remove it."
fi

# ---------------------------------------------------------------------------
# 8. Done
# ---------------------------------------------------------------------------
echo ""
ok "rollback-test-location complete."
echo ""
echo "  Restored from: $BACKUP_PATH"
echo "  Proxy host #$HOST_ID ($BACKUP_DOMAINS) -> $BACKUP_FWD"
echo ""
