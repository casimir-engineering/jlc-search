#!/usr/bin/env bash
#
# configure-npm.sh — Idempotent Nginx Proxy Manager setup
#
# Creates (or updates) a proxy host for the primary site domain (DOMAIN)
# plus any legacy aliases listed in DOMAIN_ALIASES, provisions a
# Let's Encrypt certificate per host, and enables Force-SSL + HTTP/2.
#
# Every configured domain forwards to localhost:8080 (the frontend nginx),
# which is the same backend. This is the pattern used for the
# casimir.engineering -> the-chipyard.com migration: the legacy hostname
# keeps serving the site so that MCP clients (which POST to /mcp-api/mcp
# and do NOT follow HTTP redirects) continue to work, while real users are
# migrated to the canonical hostname by the client-side redirect in
# frontend/index.html.
#
# Usage:
#   make configure-npm                       # sources .env automatically
#   DOMAIN=example.com bash scripts/configure-npm.sh
#   bash scripts/configure-npm.sh example.com
#   DOMAIN_ALIASES="old1.com old2.com" bash scripts/configure-npm.sh
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — from .env, environment, or first argument
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Source .env if present and vars not already set
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
    set +a
fi

DOMAIN="${1:-${DOMAIN:-}}"
if [ -z "$DOMAIN" ]; then
    echo "ERROR: DOMAIN not set. Pass as argument or set in .env"
    exit 1
fi

# Space-separated list of legacy hostnames that should also serve the site.
DOMAIN_ALIASES="${DOMAIN_ALIASES:-}"

NPM_URL="http://localhost:81"
NPM_EMAIL="${NPM_ADMIN_EMAIL:-admin@example.com}"
NPM_PASS="${NPM_ADMIN_PASS:-changeme}"
# Current NPM versions register Let's Encrypt with the authenticated user's
# account email, not a per-cert letsencrypt_email field. LETSENCRYPT_EMAIL
# is still honored: if set, we update the admin user's profile before
# requesting certs so LE registrations use the intended address.
LE_EMAIL="${LETSENCRYPT_EMAIL:-}"

# The host:port that NPM should proxy to.  With network_mode: host the
# frontend nginx listens on 8080 on the host network.
FORWARD_HOST="127.0.0.1"
FORWARD_PORT=8080

echo "=== Configuring Nginx Proxy Manager ==="
echo "Primary:      $DOMAIN"
if [ -n "$DOMAIN_ALIASES" ]; then
    echo "Aliases:      $DOMAIN_ALIASES"
fi
echo "Forward to:   $FORWARD_HOST:$FORWARD_PORT"
echo "LE email:     ${LE_EMAIL:-(not set — will skip SSL)}"
echo ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
fail() { echo "ERROR: $*" >&2; exit 1; }

npm_api() {
    # npm_api METHOD PATH [JSON_BODY]
    local method="$1" path="$2" body="${3:-}"
    local -a curl_args=( -sf -X "$method" "$NPM_URL$path" )
    [ -n "${TOKEN:-}" ] && curl_args+=( -H "Authorization: Bearer $TOKEN" )
    curl_args+=( -H "Content-Type: application/json" )
    [ -n "$body" ] && curl_args+=( -d "$body" )
    curl "${curl_args[@]}"
}

# ---------------------------------------------------------------------------
# 1. Wait for NPM to be ready (up to 60 s)
# ---------------------------------------------------------------------------
echo "Waiting for NPM API on port 81..."
for i in $(seq 1 30); do
    if curl -sf "$NPM_URL/api/" >/dev/null 2>&1; then
        echo "  NPM is ready."
        break
    fi
    if [ "$i" -eq 30 ]; then
        fail "NPM did not respond after 60 s. Check: docker compose logs npm"
    fi
    sleep 2
done

# ---------------------------------------------------------------------------
# 2. Handle first-time setup (default credentials)
# ---------------------------------------------------------------------------
# NPM ships with default credentials admin@example.com / changeme.
# On first login it forces a password change via PUT /api/users/{id}.
# We detect this by trying to log in with the defaults.

try_login() {
    # Returns the token on success, empty string on failure.
    local email="$1" pass="$2"
    curl -sf "$NPM_URL/api/tokens" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg id "$email" --arg secret "$pass" \
            '{identity: $id, secret: $secret}')" \
    | jq -r '.token // empty' 2>/dev/null || true
}

TOKEN=""

# First, try the configured credentials (they may already be set from a
# previous run).
echo "Authenticating with configured credentials..."
TOKEN=$(try_login "$NPM_EMAIL" "$NPM_PASS")

if [ -z "$TOKEN" ]; then
    echo "  Configured credentials did not work — trying default admin@example.com / changeme..."
    TOKEN=$(try_login "admin@example.com" "changeme")

    if [ -z "$TOKEN" ]; then
        fail "Cannot authenticate with either configured or default credentials.
  Set NPM_ADMIN_EMAIL and NPM_ADMIN_PASS in .env to match your NPM admin."
    fi

    echo "  Logged in with default credentials.  Changing admin details..."

    # Fetch the admin user id (should be 1, but let's be safe)
    ADMIN_USER=$(npm_api GET /api/users | jq '.[0]')
    ADMIN_ID=$(echo "$ADMIN_USER" | jq -r '.id')

    # Update name & email
    npm_api PUT "/api/users/$ADMIN_ID" "$(jq -n \
        --arg email "$NPM_EMAIL" \
        --arg name "Admin" \
        --arg nick "admin" \
        '{email: $email, name: $name, nickname: $nick, is_disabled: false, roles: ["admin"]}'
    )" >/dev/null

    # Change password
    npm_api PUT "/api/users/$ADMIN_ID/auth" "$(jq -n \
        --arg cur "changeme" \
        --arg new "$NPM_PASS" \
        '{type: "password", current: $cur, secret: $new}'
    )" >/dev/null

    echo "  Admin updated to $NPM_EMAIL with new password."

    # Re-login with new credentials
    TOKEN=$(try_login "$NPM_EMAIL" "$NPM_PASS")
    [ -z "$TOKEN" ] && fail "Re-login after password change failed."
    echo "  Re-authenticated successfully."
fi

echo "  Authenticated."

# ---------------------------------------------------------------------------
# 2b. Sync LE_EMAIL onto the admin user profile. Current NPM versions take
#     the Let's Encrypt registration email from the authenticated user's
#     account, not from a per-cert field, so the admin user's email must
#     be the address we want on LE registrations.
# ---------------------------------------------------------------------------
if [ -n "$LE_EMAIL" ]; then
    CUR_ME=$(npm_api GET /api/users/me)
    CUR_ME_EMAIL=$(echo "$CUR_ME" | jq -r '.email // empty')
    CUR_ME_ID=$(echo "$CUR_ME" | jq -r '.id // empty')
    if [ -n "$CUR_ME_ID" ] && [ "$CUR_ME_EMAIL" != "$LE_EMAIL" ]; then
        echo "  Updating admin user email to $LE_EMAIL (for Let's Encrypt registration)..."
        CUR_ME_NAME=$(echo "$CUR_ME" | jq -r '.name // "Administrator"')
        CUR_ME_NICK=$(echo "$CUR_ME" | jq -r '.nickname // "admin"')
        npm_api PUT "/api/users/$CUR_ME_ID" "$(jq -n \
            --arg email "$LE_EMAIL" \
            --arg name "$CUR_ME_NAME" \
            --arg nick "$CUR_ME_NICK" \
            '{email: $email, name: $name, nickname: $nick, is_disabled: false, roles: ["admin"]}')" >/dev/null
    fi
fi

# ---------------------------------------------------------------------------
# 3. Per-host configuration — runs once for DOMAIN and once per DOMAIN_ALIASES entry.
# ---------------------------------------------------------------------------
configure_host() {
    local DOMAIN="$1"

    echo ""
    echo "--- Configuring host: $DOMAIN ---"
    echo "Looking for existing proxy host for $DOMAIN..."

    local HOSTS_JSON EXISTING_HOST EXISTING_ID EXISTING_CERT EXISTING_SSL EXISTING_HTTP2
    local HOST_ID CERTS_JSON EXISTING_CERT_ID CERT_ID CERT_RESPONSE

    HOSTS_JSON=$(npm_api GET /api/nginx/proxy-hosts)

    # Find existing host by domain name
    EXISTING_HOST=$(echo "$HOSTS_JSON" | jq --arg d "$DOMAIN" '
        [.[] | select(.domain_names[]? == $d)] | first // empty
    ')
    EXISTING_ID=$(echo "$EXISTING_HOST" | jq -r '.id // empty' 2>/dev/null || true)

# ---------------------------------------------------------------------------
# 4. Build the proxy-host payload (without SSL initially)
# ---------------------------------------------------------------------------
build_host_payload() {
    local cert_id="${1:-0}" force_ssl="${2:-false}" http2="${3:-false}" hsts="${4:-false}"
    jq -n \
        --arg domain "$DOMAIN" \
        --arg fwd_host "$FORWARD_HOST" \
        --argjson fwd_port "$FORWARD_PORT" \
        --argjson cert_id "$cert_id" \
        --argjson ssl_forced "$force_ssl" \
        --argjson http2 "$http2" \
        --argjson hsts "$hsts" \
        '{
            domain_names: [$domain],
            forward_scheme: "http",
            forward_host: $fwd_host,
            forward_port: $fwd_port,
            block_exploits: true,
            allow_websocket_upgrade: false,
            access_list_id: 0,
            certificate_id: $cert_id,
            ssl_forced: $ssl_forced,
            http2_support: $http2,
            hsts_enabled: $hsts,
            hsts_subdomains: false,
            meta: {},
            advanced_config: "",
            locations: [],
            caching_enabled: false
        }'
}

# ---------------------------------------------------------------------------
# 5. Create or update proxy host (without SSL first)
# ---------------------------------------------------------------------------
if [ -n "$EXISTING_ID" ]; then
    EXISTING_CERT=$(echo "$EXISTING_HOST" | jq -r '.certificate_id // 0')
    echo "  Found existing proxy host (ID: $EXISTING_ID, cert: $EXISTING_CERT)."
    HOST_ID="$EXISTING_ID"

    # If it already has SSL configured, we can skip most of the work
    if [ "$EXISTING_CERT" != "0" ] && [ "$EXISTING_CERT" != "null" ]; then
        EXISTING_SSL=$(echo "$EXISTING_HOST" | jq -r '.ssl_forced // false')
        EXISTING_HTTP2=$(echo "$EXISTING_HOST" | jq -r '.http2_support // false')
        if [ "$EXISTING_SSL" = "true" ] && [ "$EXISTING_HTTP2" = "true" ]; then
            echo "  SSL already configured and forced.  Nothing to do."
            echo "  https://$DOMAIN is already configured."
            return 0
        fi
        # SSL cert exists but settings need updating
        echo "  Updating SSL settings..."
        npm_api PUT "/api/nginx/proxy-hosts/$HOST_ID" \
            "$(build_host_payload "$EXISTING_CERT" true true true)" >/dev/null
        echo "  Force-SSL and HTTP/2 enabled."
        echo "  Done: https://$DOMAIN"
        return 0
    fi

    # No cert yet — update the host to make sure forward target is correct
    echo "  Updating proxy host forward target..."
    npm_api PUT "/api/nginx/proxy-hosts/$HOST_ID" \
        "$(build_host_payload 0 false false false)" >/dev/null
else
    echo "  No existing proxy host found. Creating one..."
    HOST_ID=$(npm_api POST /api/nginx/proxy-hosts \
        "$(build_host_payload 0 false false false)" \
    | jq -r '.id')
    if [ -z "$HOST_ID" ] || [ "$HOST_ID" = "null" ]; then
        echo "  ERROR: Failed to create proxy host for $DOMAIN." >&2
        return 1
    fi
    echo "  Proxy host created (ID: $HOST_ID)."
fi

# ---------------------------------------------------------------------------
# 6. Request Let's Encrypt certificate
# ---------------------------------------------------------------------------
if [ -z "$LE_EMAIL" ]; then
    echo ""
    echo "WARNING: LETSENCRYPT_EMAIL not set — skipping SSL for $DOMAIN."
    echo "  Proxy host is reachable at http://$DOMAIN (no HTTPS yet)."
    echo "  Set LETSENCRYPT_EMAIL in .env and re-run: make configure-npm"
    return 0
fi

echo ""
echo "Checking for existing Let's Encrypt certificate..."

# See if a cert for this domain already exists
CERTS_JSON=$(npm_api GET /api/nginx/certificates)
EXISTING_CERT_ID=$(echo "$CERTS_JSON" | jq -r --arg d "$DOMAIN" '
    [.[] | select(.domain_names[]? == $d and .provider == "letsencrypt")] | first | .id // empty
' 2>/dev/null || true)

if [ -n "$EXISTING_CERT_ID" ]; then
    echo "  Found existing certificate (ID: $EXISTING_CERT_ID)."
    CERT_ID="$EXISTING_CERT_ID"
else
    echo "Requesting Let's Encrypt certificate for $DOMAIN..."
    echo "  (This may take 30–60 s while ACME validates the domain.)"

    # NPM cert-create schema only accepts a small set of meta keys; email
    # and agree-to-ToS are taken from the authenticated admin user (synced
    # in step 2b above).
    CERT_RESPONSE=$(npm_api POST /api/nginx/certificates \
        "$(jq -n --arg domain "$DOMAIN" '{
            provider: "letsencrypt",
            domain_names: [$domain],
            meta: { dns_challenge: false }
        }')" 2>&1) || {
        echo "  Certificate request failed for $DOMAIN.  Response:"
        echo "  $CERT_RESPONSE"
        echo ""
        echo "  Common causes:"
        echo "    - DNS for $DOMAIN does not point to this server"
        echo "    - Ports 80/443 not open in firewall"
        echo "    - Let's Encrypt rate limit reached"
        echo ""
        echo "  Proxy host was created (http://$DOMAIN works).  Fix the above and re-run: make configure-npm"
        return 1
    }

    CERT_ID=$(echo "$CERT_RESPONSE" | jq -r '.id // empty')
    if [ -z "$CERT_ID" ] || [ "$CERT_ID" = "null" ]; then
        echo "  Certificate request returned unexpected response:"
        echo "  $CERT_RESPONSE"
        return 1
    fi
    echo "  Certificate obtained (ID: $CERT_ID)."
fi

# ---------------------------------------------------------------------------
# 7. Update proxy host to enable SSL
# ---------------------------------------------------------------------------
echo "Enabling Force-SSL, HTTP/2, and HSTS on proxy host..."
npm_api PUT "/api/nginx/proxy-hosts/$HOST_ID" \
    "$(build_host_payload "$CERT_ID" true true true)" >/dev/null

echo "  Done: https://$DOMAIN (cert ID $CERT_ID, host ID $HOST_ID)"
}  # end configure_host

# ---------------------------------------------------------------------------
# 8. Dispatch: configure the primary DOMAIN, then each alias.
# ---------------------------------------------------------------------------
configure_host "$DOMAIN"

FAILED=""
for alias_host in $DOMAIN_ALIASES; do
    if ! configure_host "$alias_host"; then
        FAILED="${FAILED} ${alias_host}"
    fi
done

echo ""
echo "=== DONE ==="
echo "  Primary: https://$DOMAIN"
if [ -n "$DOMAIN_ALIASES" ]; then
    echo "  Aliases: $DOMAIN_ALIASES"
fi
if [ -n "$FAILED" ]; then
    echo ""
    echo "  WARNING: some aliases failed:${FAILED}"
    echo "  The primary domain was configured successfully. Re-run once DNS"
    echo "  for the failed aliases points at this server."
    exit 1
fi
