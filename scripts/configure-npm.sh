#!/usr/bin/env bash
set -euo pipefail

NPM_URL="http://localhost:81"
DOMAIN="${DOMAIN:-jlcsearch.casimir.engineering}"
NPM_EMAIL="${NPM_ADMIN_EMAIL:-admin@example.com}"
NPM_PASS="${NPM_ADMIN_PASS:-changeme}"
LE_EMAIL="${LETSENCRYPT_EMAIL:-}"

echo "=== Configuring Nginx Proxy Manager ==="
echo "Domain: $DOMAIN"

# Check if NPM needs initial setup (no users exist yet)
SETUP_STATUS=$(curl -sf "$NPM_URL/api/" | python3 -c "import sys,json; print(json.load(sys.stdin).get('setup', True))")

if [ "$SETUP_STATUS" = "False" ]; then
    echo "First-time setup: creating admin user..."
    python3 -c "
import urllib.request, json
data = json.dumps({
    'name': 'Admin',
    'nickname': 'admin',
    'email': '$NPM_EMAIL',
    'roles': ['admin'],
    'is_disabled': False,
    'auth': {'type': 'password', 'secret': '$NPM_PASS'}
}).encode()
req = urllib.request.Request('$NPM_URL/api/users', data=data, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req)
result = json.loads(resp.read())
print(f\"  Admin user created (ID: {result['id']}, email: {result['email']})\")" || {
        echo "ERROR: Failed to create admin user."
        exit 1
    }
fi

# Authenticate
echo "Authenticating..."
TOKEN=$(curl -sf "$NPM_URL/api/tokens" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$NPM_EMAIL\",\"secret\":\"$NPM_PASS\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

if [ -z "$TOKEN" ]; then
    echo "ERROR: Authentication failed."
    echo "  Set NPM_ADMIN_EMAIL and NPM_ADMIN_PASS in .env to match your NPM credentials."
    exit 1
fi

AUTH="Authorization: Bearer $TOKEN"

# Check if proxy host already exists
EXISTING=$(curl -sf "$NPM_URL/api/nginx/proxy-hosts" -H "$AUTH" \
  | python3 -c "
import sys, json
hosts = json.load(sys.stdin)
print('true' if any('$DOMAIN' in h.get('domain_names', []) for h in hosts) else 'false')
")

if [ "$EXISTING" = "true" ]; then
    echo "Proxy host for $DOMAIN already exists. Skipping creation."
    exit 0
fi

# Create proxy host (without SSL initially)
echo "Creating proxy host for $DOMAIN -> 127.0.0.1:8080..."
HOST_ID=$(curl -sf "$NPM_URL/api/nginx/proxy-hosts" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "domain_names": ["'"$DOMAIN"'"],
    "forward_scheme": "http",
    "forward_host": "127.0.0.1",
    "forward_port": 8080,
    "block_exploits": true,
    "allow_websocket_upgrade": false,
    "access_list_id": 0,
    "certificate_id": 0,
    "ssl_forced": false,
    "http2_support": false,
    "hsts_enabled": false,
    "hsts_subdomains": false,
    "meta": {"letsencrypt_agree": false, "dns_challenge": false},
    "advanced_config": "",
    "locations": [],
    "caching_enabled": false
  }' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "Proxy host created (ID: $HOST_ID)"

# Request SSL certificate if LE email is provided
if [ -z "$LE_EMAIL" ]; then
    echo ""
    echo "WARNING: LETSENCRYPT_EMAIL not set in .env — skipping SSL setup."
    echo "  Set LETSENCRYPT_EMAIL in .env and re-run: make configure-npm"
    echo "  Proxy host is reachable at http://$DOMAIN (no HTTPS yet)."
    exit 0
fi

echo "Requesting Let's Encrypt certificate..."
CERT_ID=$(curl -sf "$NPM_URL/api/nginx/certificates" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "domain_names": ["'"$DOMAIN"'"],
    "meta": {},
    "provider": "letsencrypt",
    "nice_name": "'"$DOMAIN"'"
  }' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "Certificate obtained (ID: $CERT_ID)"

# Update proxy host to enable SSL
echo "Enabling SSL..."
curl -sf -X PUT "$NPM_URL/api/nginx/proxy-hosts/$HOST_ID" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "domain_names": ["'"$DOMAIN"'"],
    "forward_scheme": "http",
    "forward_host": "127.0.0.1",
    "forward_port": 8080,
    "block_exploits": true,
    "allow_websocket_upgrade": false,
    "access_list_id": 0,
    "certificate_id": '"$CERT_ID"',
    "ssl_forced": true,
    "http2_support": true,
    "hsts_enabled": true,
    "hsts_subdomains": false,
    "meta": {},
    "advanced_config": "",
    "locations": [],
    "caching_enabled": false
  }' >/dev/null

echo ""
echo "Done! $DOMAIN is now served over HTTPS with Let's Encrypt."
echo "Verify: https://$DOMAIN"
