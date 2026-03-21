# SETUP.md — jlc-search Server Setup Guide

## Prerequisites

- **OS**: Ubuntu 22.04+ or Debian 12+ (setup.sh targets apt; other Linux distros work with manual Docker install)
- **RAM**: 4GB minimum (PostgreSQL uses 1.5GB shared buffers)
- **Disk**: 50GB recommended (DB ~10GB, raw data ~16GB, datasheets ~6GB)
- **Domain**: A domain name with DNS A record pointing to the server IP
- **Ports**: 80 and 443 open (for HTTPS via Let's Encrypt)

## One-Command Setup

```bash
git clone https://github.com/casimir-engineering/jlc-search.git
cd jlc-search
./setup.sh your-domain.com
```

This single command:
1. Installs Docker and Docker Compose (if missing)
2. Installs `poppler-utils` for PDF text extraction (if missing)
3. Creates `.env` from `.env.example` with auto-generated passwords
4. Sets the domain and CORS origins
5. Builds all Docker images
6. Starts all services (PostgreSQL, backend, frontend, Nginx Proxy Manager)
7. Waits for PostgreSQL to be healthy
8. Applies the database schema
9. Prints next steps

### Setup Script Options

```bash
./setup.sh                     # Local/dev setup (domain=localhost, no SSL)
./setup.sh jlcsearch.example.com  # Production setup with domain
```

The script is **idempotent** — safe to run multiple times. It won't overwrite an existing `.env` or regenerate passwords that have already been customized.

## After Setup

### 1. Configure SSL (Production)

```bash
make configure-npm
```

This automatically:
- Logs into Nginx Proxy Manager
- Creates a proxy host for your domain → localhost:8080
- Requests a Let's Encrypt SSL certificate
- Enables Force SSL and HTTP/2

**Manual alternative**: Open `http://your-server-ip:81` in a browser, log in with the credentials from `.env`, and configure the proxy host manually.

### 2. Run Data Ingestion

The database starts empty. Populate it with parts data:

```bash
# Quick start: jlcparts mirror (~15 min, ~3.2M parts)
make ingest

# Or run download and process separately:
make download    # Download raw data (no DB needed)
make process     # Process into PostgreSQL

# Full JLCPCB API ingestion (all parts, takes hours):
docker compose run --rm ingest ingest/src/jlcpcb-api.ts

# Datasheet indexing (PDFs → text → property extraction):
make datasheets
```

For automated ingestion with monitoring, use the `/ingest` skill in Claude Code.

### 3. Verify

```bash
curl http://localhost:3001/api/status
curl "http://localhost:3001/api/search?q=100nF&limit=3"
```

## Environment Variables

All configuration is in `.env` (copied from `.env.example` by setup.sh):

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | PostgreSQL password | Auto-generated |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://jlc:<password>@localhost:5432/jlc` |
| `PORT` | Backend API port | `3001` |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) | `http://localhost:3000` |
| `JLCPARTS_BASE` | jlcparts mirror base URL | `https://yaqwsx.github.io/jlcparts` |
| `INGEST_CONCURRENCY` | Parallel download workers | `4` |
| `DOMAIN` | Production domain for SSL | — |
| `NPM_ADMIN_EMAIL` | Nginx Proxy Manager admin email | — |
| `NPM_ADMIN_PASS` | Nginx Proxy Manager admin password | Auto-generated |
| `LETSENCRYPT_EMAIL` | Email for Let's Encrypt certificates | — |

## Services Architecture

```
Internet → :443 (NPM, HTTPS/TLS) → :8080 (Frontend Nginx) → static SPA
                                                            → /api/* → :3001 (Backend Bun/Hono) → :5432 (PostgreSQL)
         → :80  (NPM) → 301 redirect to HTTPS
```

| Service | Port | Image | Purpose |
|---------|------|-------|---------|
| `db` | 5432 | postgres:17-alpine | PostgreSQL with pg_trgm + tsvector |
| `backend` | 3001 | jlc-search-backend | Bun + Hono API server |
| `frontend` | 8080 | jlc-search-frontend | Nginx serving React SPA + proxying /api |
| `npm` | 80, 443, 81 | nginx-proxy-manager | HTTPS termination, Let's Encrypt |
| `ingest` | — | jlc-search-ingest | On-demand data ingestion |

## Docker Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| `pg_data` | PostgreSQL data dir | Persists database across restarts |
| `img_cache` | `/app/data/img` | Cached product images, schematics, footprints |
| `raw_data` | `/app/data/raw` | Downloaded raw data (jlcparts, JLCPCB pages, datasheets) |
| `npm_data` | NPM config | Proxy host configurations |
| `npm_letsencrypt` | NPM certs | SSL certificates |

## Manual Setup (Step by Step)

If you prefer not to use `setup.sh`:

```bash
# 1. Clone
git clone https://github.com/casimir-engineering/jlc-search.git
cd jlc-search

# 2. Create .env
cp .env.example .env
nano .env   # Set POSTGRES_PASSWORD, DOMAIN, emails, etc.

# 3. Build
docker compose build

# 4. Start
docker compose up -d

# 5. Wait for DB
docker compose exec db pg_isready -U jlc   # repeat until ready

# 6. Ingest data
docker compose run --rm ingest

# 7. Configure SSL
make configure-npm
# Or: open http://server-ip:81, login, add proxy host manually
```

## Updating

```bash
cd jlc-search
git pull
docker compose build
docker compose up -d
```

The database schema is applied automatically on backend startup (`applySchema()` is idempotent).

## Backup & Restore

```bash
# Backup
docker compose exec db pg_dump -U jlc -Fc jlc > backup.dump

# Restore
docker compose exec -i db pg_restore -U jlc -d jlc --clean < backup.dump
```

## Troubleshooting

### Backend won't start
```bash
docker compose logs backend --tail 30
```
Common causes: schema timeout on first run (restart fixes it), port conflict (`lsof -i :3001`).

### SSL certificate fails
- Ensure DNS A record points to the server IP
- Ensure ports 80 and 443 are open (`ufw allow 80 && ufw allow 443`)
- Check NPM logs: `docker compose logs npm --tail 30`
- Let's Encrypt rate limits: max 5 certs per domain per week

### Search returns 0 results
Run ingestion first: `make ingest` or `docker compose run --rm ingest`

### Disk full
```bash
df -h
du -sh data/raw/*/
```
Datasheets use the most space. Delete `data/raw/datasheets/*.pdf` if needed (`.txt` files are kept for reprocessing).

### Nginx Proxy Manager admin
Access at `http://server-ip:81`. Default login is in your `.env` file (`NPM_ADMIN_EMAIL` / `NPM_ADMIN_PASS`). Port 81 should NOT be exposed to the internet — use SSH tunnel if remote: `ssh -L 8181:localhost:81 user@server`.
