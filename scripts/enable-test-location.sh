#!/usr/bin/env bash
# =============================================================================
# enable-test-location.sh — Inject the /test/ nginx location into NPM host #3
#
# Adds (or no-ops if already present) an nginx `location /test/` block to
# the `advanced_config` of Nginx Proxy Manager proxy host ID 3 — which
# serves https://search.the-chipyard.com. The location proxies /test/ to
# the staging frontend running on 127.0.0.1:8081.
#
# Before mutating anything, the full proxy-host JSON is backed up to
# data/npm-backup/proxy-host-3.<timestamp>.json so rollback-test-location.sh
# can restore it.
#
# Idempotent: if advanced_config already contains `location /test/`, exits 0.
#
# Usage:
#   ./scripts/enable-test-location.sh
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
BACKUP_FILE="$BACKUP_DIR/proxy-host-${HOST_ID}.$(date +%Y%m%d-%H%M%S).json"

# ---------------------------------------------------------------------------
# 2. The exact nginx block we want to append. KEEP IN SYNC with the
#    idempotency check below (`grep 'location /test/'`).
# ---------------------------------------------------------------------------
read -r -d '' TEST_LOCATION_BLOCK <<'NGINX' || true
location /test/ {
    proxy_pass http://127.0.0.1:8081/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 300s;
    client_max_body_size 1m;
}
NGINX

# ---------------------------------------------------------------------------
# 3. Authenticate against NPM
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

npm_get()  { curl -sf -X GET    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$NPM_URL$1"; }
npm_put()  { curl -sf -X PUT    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2" "$NPM_URL$1"; }

# ---------------------------------------------------------------------------
# 4. Fetch current proxy host #3
# ---------------------------------------------------------------------------
info "Fetching proxy host #$HOST_ID..."
HOST_JSON=$(npm_get "/api/nginx/proxy-hosts/$HOST_ID") \
  || err "Failed to fetch proxy host #$HOST_ID. Does it exist?"

DOMAINS=$(echo "$HOST_JSON" | jq -r '.domain_names | join(",")')
FORWARD=$(echo "$HOST_JSON" | jq -r '"\(.forward_scheme)://\(.forward_host):\(.forward_port)"')
ok "Proxy host #$HOST_ID: $DOMAINS -> $FORWARD"

# ---------------------------------------------------------------------------
# 5. Back up the full host JSON before mutating anything
# ---------------------------------------------------------------------------
mkdir -p "$BACKUP_DIR"
echo "$HOST_JSON" | jq '.' > "$BACKUP_FILE"
ok "Backed up current proxy host JSON to: $BACKUP_FILE"

# ---------------------------------------------------------------------------
# 6. Idempotency check: does the current advanced_config already contain
#    `location /test/`?
# ---------------------------------------------------------------------------
CURRENT_AC=$(echo "$HOST_JSON" | jq -r '.advanced_config // ""')

if echo "$CURRENT_AC" | grep -q 'location /test/'; then
  ok "advanced_config already contains 'location /test/'. Nothing to do."
  echo ""
  echo "  Backup file (not used): $BACKUP_FILE"
  echo "  To roll back the last real change: ./scripts/rollback-test-location.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# 7. Build the new advanced_config — existing content + two blank lines +
#    our new block. If existing is empty, use just our block.
# ---------------------------------------------------------------------------
if [ -z "$CURRENT_AC" ]; then
  NEW_AC="$TEST_LOCATION_BLOCK"
else
  NEW_AC="${CURRENT_AC}"$'\n\n'"${TEST_LOCATION_BLOCK}"
fi

# ---------------------------------------------------------------------------
# 8. Build the PUT payload — use a whitelist of fields the PUT schema accepts.
#    NPM's PUT /api/nginx/proxy-hosts/:id schema has additionalProperties:false
#    and only allows a specific subset of keys; the GET response carries extra
#    read-only fields (id, created_on, modified_on, owner_user_id, owner,
#    certificate, access_list) that trigger a 400. Build from scratch with
#    only the allowed keys.
# ---------------------------------------------------------------------------
PAYLOAD=$(echo "$HOST_JSON" | jq \
  --arg ac "$NEW_AC" \
  '{
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
     advanced_config: $ac,
     locations
   }')

# ---------------------------------------------------------------------------
# 9. PUT it back
# ---------------------------------------------------------------------------
info "Updating proxy host #$HOST_ID with new advanced_config..."
if ! npm_put "/api/nginx/proxy-hosts/$HOST_ID" "$PAYLOAD" >/dev/null; then
  err "PUT /api/nginx/proxy-hosts/$HOST_ID failed. Proxy host NOT modified. Backup is at $BACKUP_FILE."
fi
ok "PUT succeeded."

# ---------------------------------------------------------------------------
# 10. Verify
# ---------------------------------------------------------------------------
info "Verifying the update..."
VERIFY_JSON=$(npm_get "/api/nginx/proxy-hosts/$HOST_ID") \
  || err "Verify GET failed. Check NPM state manually."

VERIFY_AC=$(echo "$VERIFY_JSON" | jq -r '.advanced_config // ""')
if echo "$VERIFY_AC" | grep -q 'location /test/'; then
  ok "Verified: advanced_config now contains 'location /test/'."
else
  err "Verification failed — advanced_config does not contain 'location /test/'. Backup: $BACKUP_FILE"
fi

# ---------------------------------------------------------------------------
# 11. Done
# ---------------------------------------------------------------------------
echo ""
ok "enable-test-location complete."
echo ""
echo "  Proxy host:      #$HOST_ID ($DOMAINS)"
echo "  Forwards /test/: http://127.0.0.1:8081/"
echo "  Backup file:     $BACKUP_FILE"
echo ""
echo "  Smoke test:"
echo "    curl -I https://search.the-chipyard.com/test/"
echo ""
echo "  Rollback (restores the most recent backup):"
echo "    ./scripts/rollback-test-location.sh"
echo ""
