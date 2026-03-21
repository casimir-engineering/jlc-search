#!/usr/bin/env bash
#
# configure-npm.sh — Idempotent Nginx Proxy Manager setup
#
# Creates (or updates) a proxy host for the site domain, provisions a
# Let's Encrypt certificate, and enables Force-SSL + HTTP/2.
#
# Usage:
#   make configure-npm            # sources .env automatically
#   DOMAIN=example.com bash scripts/configure-npm.sh
#   bash scripts/configure-npm.sh example.com
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

NPM_URL="http://localhost:81"
NPM_EMAIL="${NPM_ADMIN_EMAIL:-admin@example.com}"
NPM_PASS="${NPM_ADMIN_PASS:-changeme}"
LE_EMAIL="${LETSENCRYPT_EMAIL:-}"

# The host:port that NPM should proxy to.  With network_mode: host the
# frontend nginx listens on 8080 on the host network.
FORWARD_HOST="127.0.0.1"
FORWARD_PORT=8080

echo "=== Configuring Nginx Proxy Manager ==="
echo "Domain:       $DOMAIN"
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
# 3. Check for existing proxy host
# ---------------------------------------------------------------------------
echo ""
echo "Looking for existing proxy host for $DOMAIN..."

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
            echo ""
            echo "Done! https://$DOMAIN is already configured."
            exit 0
        fi
        # SSL cert exists but settings need updating
        echo "  Updating SSL settings..."
        npm_api PUT "/api/nginx/proxy-hosts/$HOST_ID" \
            "$(build_host_payload "$EXISTING_CERT" true true true)" >/dev/null
        echo "  Force-SSL and HTTP/2 enabled."
        echo ""
        echo "Done! https://$DOMAIN"
        exit 0
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
    [ -z "$HOST_ID" ] || [ "$HOST_ID" = "null" ] && fail "Failed to create proxy host."
    echo "  Proxy host created (ID: $HOST_ID)."
fi

# ---------------------------------------------------------------------------
# 6. Request Let's Encrypt certificate
# ---------------------------------------------------------------------------
if [ -z "$LE_EMAIL" ]; then
    echo ""
    echo "WARNING: LETSENCRYPT_EMAIL not set — skipping SSL."
    echo "  Proxy host is reachable at http://$DOMAIN (no HTTPS yet)."
    echo "  Set LETSENCRYPT_EMAIL in .env and re-run: make configure-npm"
    exit 0
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

    CERT_RESPONSE=$(npm_api POST /api/nginx/certificates \
        "$(jq -n --arg domain "$DOMAIN" --arg email "$LE_EMAIL" '{
            domain_names: [$domain],
            meta: {
                letsencrypt_email: $email,
                letsencrypt_agree: true,
                dns_challenge: false
            },
            provider: "letsencrypt"
        }')" 2>&1) || {
        echo "  Certificate request failed.  Response:"
        echo "  $CERT_RESPONSE"
        echo ""
        echo "  Common causes:"
        echo "    - DNS for $DOMAIN does not point to this server"
        echo "    - Ports 80/443 not open in firewall"
        echo "    - Let's Encrypt rate limit reached"
        echo ""
        echo "  Proxy host was created (http://$DOMAIN works).  Fix the above and re-run: make configure-npm"
        exit 1
    }

    CERT_ID=$(echo "$CERT_RESPONSE" | jq -r '.id // empty')
    if [ -z "$CERT_ID" ] || [ "$CERT_ID" = "null" ]; then
        echo "  Certificate request returned unexpected response:"
        echo "  $CERT_RESPONSE"
        exit 1
    fi
    echo "  Certificate obtained (ID: $CERT_ID)."
fi

# ---------------------------------------------------------------------------
# 7. Update proxy host to enable SSL
# ---------------------------------------------------------------------------
echo "Enabling Force-SSL, HTTP/2, and HSTS on proxy host..."
npm_api PUT "/api/nginx/proxy-hosts/$HOST_ID" \
    "$(build_host_payload "$CERT_ID" true true true)" >/dev/null

echo ""
echo "=== DONE ==="
echo "  https://$DOMAIN is now served over HTTPS with Let's Encrypt."
echo "  Certificate ID: $CERT_ID"
echo "  Proxy Host ID:  $HOST_ID"
