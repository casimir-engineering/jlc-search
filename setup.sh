#!/usr/bin/env bash
# =============================================================================
# jlc-search one-command setup
#
# Usage:
#   ./setup.sh                      # local/dev setup (domain=localhost)
#   ./setup.sh jlcsearch.example.com  # production setup with domain
#
# Safe to run multiple times (idempotent).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DOMAIN="${1:-}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m    $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
err()   { echo -e "\033[1;31m[ERROR]\033[0m $*"; exit 1; }

generate_password() {
  # 24-char alphanumeric, no special chars (safe for URLs and shell)
  head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 24
}

# ---------------------------------------------------------------------------
# 1. Check / install Docker
# ---------------------------------------------------------------------------
info "Checking prerequisites..."

install_docker() {
  info "Installing Docker Engine (Ubuntu/Debian)..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg \
      | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ok "Docker installed."
}

if ! command -v docker &>/dev/null; then
  warn "Docker not found."
  install_docker
else
  ok "Docker found: $(docker --version)"
fi

if ! docker compose version &>/dev/null; then
  if ! command -v docker-compose &>/dev/null; then
    warn "Docker Compose not found."
    install_docker
  else
    # Legacy docker-compose binary exists but 'docker compose' plugin missing.
    # The project uses 'docker compose' (v2 syntax). Try to proceed.
    warn "docker compose plugin not found, but docker-compose is available."
    warn "Consider upgrading: https://docs.docker.com/compose/install/"
  fi
else
  ok "Docker Compose found: $(docker compose version)"
fi

# Make sure Docker daemon is running
if ! docker info &>/dev/null; then
  info "Starting Docker daemon..."
  sudo systemctl start docker || sudo service docker start || true
  sleep 2
  docker info &>/dev/null || err "Docker daemon failed to start."
fi
ok "Docker daemon running."

# ---------------------------------------------------------------------------
# 2. Install poppler-utils (for PDF text extraction in ingest container and host)
# ---------------------------------------------------------------------------
if ! command -v pdftotext &>/dev/null; then
  info "Installing poppler-utils (PDF text extraction)..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq poppler-utils
  ok "poppler-utils installed."
else
  ok "poppler-utils already installed."
fi

# ---------------------------------------------------------------------------
# 3. Create .env from .env.example (if it doesn't exist)
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  ok ".env already exists (not overwriting)."
  CREATED_ENV=false
else
  if [ ! -f .env.example ]; then
    err ".env.example not found. Is this the jlc-search repo root?"
  fi
  cp .env.example .env
  info "Created .env from .env.example."
  CREATED_ENV=true
fi

# ---------------------------------------------------------------------------
# 4. Fill in domain, generate passwords
# ---------------------------------------------------------------------------
# Source current .env values
set -a && source .env && set +a

# Only auto-generate passwords if they are still the defaults
CURRENT_PG_PASS=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
CURRENT_NPM_PASS=$(grep '^NPM_ADMIN_PASS=' .env | cut -d= -f2-)

if [ "$CURRENT_PG_PASS" = "changeme" ]; then
  NEW_PG_PASS=$(generate_password)
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$NEW_PG_PASS|" .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://jlc:${NEW_PG_PASS}@localhost:5432/jlc|" .env
  ok "Generated random POSTGRES_PASSWORD."
else
  NEW_PG_PASS="$CURRENT_PG_PASS"
  ok "POSTGRES_PASSWORD already customized (keeping it)."
fi

if [ "$CURRENT_NPM_PASS" = "changeme" ]; then
  NEW_NPM_PASS=$(generate_password)
  sed -i "s|^NPM_ADMIN_PASS=.*|NPM_ADMIN_PASS=$NEW_NPM_PASS|" .env
  ok "Generated random NPM_ADMIN_PASS."
else
  ok "NPM_ADMIN_PASS already customized (keeping it)."
fi

# Set domain if provided as argument
if [ -n "$DOMAIN" ]; then
  sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env
  sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://$DOMAIN|" .env
  ok "Domain set to $DOMAIN."
else
  DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
  if [ "$DOMAIN" = "example.com" ] || [ -z "$DOMAIN" ]; then
    DOMAIN="localhost"
    sed -i "s|^DOMAIN=.*|DOMAIN=localhost|" .env
    info "No domain argument provided. Using localhost (dev mode)."
  else
    ok "Using existing domain from .env: $DOMAIN"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Build Docker images
# ---------------------------------------------------------------------------
info "Building Docker images (this may take a few minutes on first run)..."
docker compose build
ok "Docker images built."

# ---------------------------------------------------------------------------
# 6. Start services
# ---------------------------------------------------------------------------
info "Starting services..."
docker compose up -d
ok "Services started."

# ---------------------------------------------------------------------------
# 7. Wait for PostgreSQL to be healthy
# ---------------------------------------------------------------------------
info "Waiting for PostgreSQL to be healthy..."
RETRIES=30
for i in $(seq 1 $RETRIES); do
  if docker compose exec -T db pg_isready -U jlc &>/dev/null; then
    ok "PostgreSQL is ready."
    break
  fi
  if [ "$i" -eq "$RETRIES" ]; then
    err "PostgreSQL did not become healthy after ${RETRIES} attempts. Check: docker compose logs db"
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
# 8. Run schema migration
# ---------------------------------------------------------------------------
info "Applying database schema..."

# Read the current DATABASE_URL from .env
set -a && source .env && set +a

# Run schema via the backend container (it has the schema code and Bun runtime)
docker compose exec -T backend bun -e "
  const { applySchema } = require('./src/schema.ts');
  const postgres = require('postgres');
  const sql = postgres(process.env.DATABASE_URL);
  applySchema(sql).then(() => { console.log('Schema applied.'); return sql.end(); }).catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null && ok "Database schema applied." || {
  # Fallback: apply schema via raw SQL using psql in the db container
  info "Applying schema via psql fallback..."
  docker compose exec -T db psql -U jlc -d jlc -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>/dev/null
  docker compose exec -T db psql -U jlc -d jlc <<'EOSQL'
    CREATE TABLE IF NOT EXISTS parts (
      lcsc         TEXT PRIMARY KEY,
      mpn          TEXT NOT NULL DEFAULT '',
      manufacturer TEXT,
      category     TEXT NOT NULL DEFAULT '',
      subcategory  TEXT NOT NULL DEFAULT '',
      description  TEXT NOT NULL DEFAULT '',
      datasheet    TEXT,
      package      TEXT,
      joints       INTEGER,
      moq          INTEGER,
      stock        INTEGER NOT NULL DEFAULT 0,
      price_raw    TEXT NOT NULL DEFAULT '',
      img          TEXT,
      url          TEXT,
      part_type    TEXT NOT NULL DEFAULT 'Extended',
      pcba_type    TEXT NOT NULL DEFAULT 'Standard',
      attributes   JSONB NOT NULL DEFAULT '{}',
      search_text  TEXT NOT NULL DEFAULT '',
      search_vec   tsvector
    );

    DO $$ BEGIN
      ALTER TABLE parts ADD COLUMN full_text TEXT NOT NULL DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE parts ADD COLUMN jlc_stock INTEGER NOT NULL DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_parts_search ON parts USING GIN(search_vec);
    CREATE INDEX IF NOT EXISTS idx_parts_mpn_trgm ON parts USING GIN(mpn gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_parts_mfr_trgm ON parts USING GIN(manufacturer gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_parts_fulltext_trgm ON parts USING GIN(full_text gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_parts_mpn ON parts(mpn);
    CREATE INDEX IF NOT EXISTS idx_parts_type ON parts(part_type);
    CREATE INDEX IF NOT EXISTS idx_parts_stock ON parts(stock);
    CREATE INDEX IF NOT EXISTS idx_parts_jlc_stock ON parts(jlc_stock);
    CREATE INDEX IF NOT EXISTS idx_parts_cat ON parts(category, subcategory);

    CREATE OR REPLACE FUNCTION update_search_vec() RETURNS trigger AS $$
    BEGIN
      NEW.search_vec :=
        setweight(to_tsvector('simple', coalesce(NEW.lcsc, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.mpn, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.manufacturer, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.subcategory, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(NEW.search_text, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(NEW.package, '')), 'D');
      NEW.full_text := lower(concat_ws(' ', NEW.lcsc, NEW.mpn,
        coalesce(NEW.manufacturer, ''), NEW.description,
        coalesce(NEW.subcategory, ''), coalesce(NEW.search_text, ''),
        coalesce(NEW.package, '')));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_parts_search_vec'
      ) THEN
        CREATE TRIGGER trg_parts_search_vec
          BEFORE INSERT OR UPDATE ON parts
          FOR EACH ROW EXECUTE FUNCTION update_search_vec();
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS part_nums (
      lcsc  TEXT NOT NULL REFERENCES parts(lcsc) ON DELETE CASCADE,
      unit  TEXT NOT NULL,
      value DOUBLE PRECISION NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pn_unit_value ON part_nums(unit, value);
    CREATE INDEX IF NOT EXISTS idx_pn_lcsc ON part_nums(lcsc);

    CREATE TABLE IF NOT EXISTS datasheet_meta (
      lcsc         TEXT PRIMARY KEY REFERENCES parts(lcsc) ON DELETE CASCADE,
      extracted_at BIGINT NOT NULL,
      page_count   INTEGER NOT NULL DEFAULT 0,
      char_count   INTEGER NOT NULL DEFAULT 0,
      props_found  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ingest_meta (
      category    TEXT NOT NULL,
      subcategory TEXT NOT NULL,
      sourcename  TEXT NOT NULL,
      datahash    TEXT NOT NULL,
      stockhash   TEXT NOT NULL,
      ingested_at BIGINT NOT NULL,
      PRIMARY KEY (category, subcategory)
    );
EOSQL
  ok "Database schema applied (via psql)."
}

# ---------------------------------------------------------------------------
# 9. Print summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================================="
echo "  jlc-search setup complete!"
echo "============================================================================="
echo ""
echo "  Services running:"
echo "    - PostgreSQL ........... localhost:5432"
echo "    - Backend API .......... localhost:3001"
echo "    - Frontend ............. localhost:8080"
echo "    - Nginx Proxy Manager .. localhost:81 (admin UI)"
echo ""
if [ "$DOMAIN" != "localhost" ]; then
echo "  Domain: $DOMAIN"
echo ""
fi
echo "  Next steps:"
echo ""
echo "  1. Ingest component data (takes ~30 min):"
echo "       docker compose run --rm ingest"
echo ""
if [ "$DOMAIN" != "localhost" ]; then
echo "  2. Configure SSL (run once, after DNS points to this server):"
echo "       Set LETSENCRYPT_EMAIL in .env, then:"
echo "       make configure-npm"
echo ""
echo "  3. If remote, access NPM admin via SSH tunnel:"
echo "       ssh -L 81:localhost:81 user@server"
echo "       Then open http://localhost:81"
echo ""
fi
echo "  Useful commands:"
echo "    docker compose logs -f        # View logs"
echo "    docker compose down            # Stop services"
echo "    docker compose up -d           # Restart services"
echo "    make ingest                    # Re-run ingestion"
echo ""
echo "  Your .env file contains the generated passwords."
echo "  Keep it safe and do not commit it to git."
echo "============================================================================="
