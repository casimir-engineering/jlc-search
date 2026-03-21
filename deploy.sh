#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== jlc-search deployment ==="

# Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose not found"; exit 1; }

if [ ! -f .env ]; then
    echo "ERROR: .env file not found. Run ./setup.sh first, or: cp .env.example .env"
    exit 1
fi

# Validate .env has production values
set -a && source .env && set +a
DOMAIN="${DOMAIN:-localhost}"
if [[ "${ALLOWED_ORIGINS:-}" != *"$DOMAIN"* ]]; then
    echo "WARNING: ALLOWED_ORIGINS does not contain $DOMAIN"
    echo "  Current: ${ALLOWED_ORIGINS:-<not set>}"
    echo "  Expected: https://$DOMAIN"
fi

# Check DNS resolution
echo "Checking DNS for $DOMAIN..."
if ! host "$DOMAIN" >/dev/null 2>&1; then
    echo "WARNING: $DOMAIN does not resolve yet. SSL certificate request will fail."
    echo "  Ensure DNS A record points to this server's public IP."
fi

# Open firewall ports if ufw is available
if command -v ufw >/dev/null 2>&1; then
    echo "Updating firewall rules..."
    sudo ufw allow 80/tcp comment "HTTP - Let's Encrypt + redirect" 2>/dev/null || true
    sudo ufw allow 443/tcp comment "HTTPS" 2>/dev/null || true
    echo "  Ports 80, 443 opened."
    echo "  NOTE: Port 81 (NPM admin) is NOT opened. Use SSH tunnel to access it:"
    echo "    ssh -L 81:localhost:81 user@server"
fi

# Build Docker images
echo "Building Docker images..."
docker compose build

# Start all services
echo "Starting all services..."
docker compose up -d

# Wait for NPM to be ready
echo "Waiting for Nginx Proxy Manager..."
for i in $(seq 1 30); do
    if curl -sf http://localhost:81/api/ >/dev/null 2>&1; then
        echo "Nginx Proxy Manager is ready!"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "WARNING: NPM did not respond after 60s. Check: docker compose logs npm"
    fi
    sleep 2
done

cat <<DEPLOY_EOF

=== DEPLOYMENT COMPLETE ===

Next steps:

1. Access NPM admin UI:
   - If local:  http://localhost:81
   - If remote: ssh -L 81:localhost:81 user@server -> http://localhost:81

2. Run the auto-configuration script to set up the proxy host + SSL:
   make configure-npm

   Or manually in NPM admin UI:
   - Add Proxy Host:
     Domain: $DOMAIN
     Forward: http -> 127.0.0.1 -> port 8080
     Enable "Block Common Exploits"
   - SSL tab:
     Request new Let's Encrypt certificate
     Check: Force SSL, HTTP/2 Support, HSTS Enabled
     Enter email for Let's Encrypt

3. Verify: https://$DOMAIN

DEPLOY_EOF
