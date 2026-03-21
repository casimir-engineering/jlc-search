# Deployment Guide

Comprehensive deployment instructions for jlc-search, a fast search engine for JLCPCB/LCSC electronic components.

## Quick Start

```bash
git clone https://github.com/casimir-engineering/jlc-search.git
cd jlc-search
cp .env.example .env
# Edit .env with your domain, email, and passwords
docker compose build
docker compose up -d
docker compose run --rm ingest   # first-time data load (~15 min)
```

## Prerequisites

- **OS**: Ubuntu 22.04+ or Debian 12+ (other Linux distros work, but `deploy.sh` uses `ufw`)
- **RAM**: 4 GB minimum (PostgreSQL is tuned for 1.5 GB shared buffers)
- **Disk**: 50 GB free (database + raw data + images)
- **Docker**: Docker Engine 24+ with the Compose V2 plugin (`docker compose`)
- **Domain**: A domain name with a DNS A record pointing to the server's public IP
- **Ports**: 80 (HTTP/Let's Encrypt) and 443 (HTTPS) open in your firewall
- **Bun** (optional): Only needed if running ingestion or development outside Docker

## Architecture

```
Internet
  |
  :443/:80  Nginx Proxy Manager (npm)
  |           - SSL termination (Let's Encrypt)
  |           - HTTP -> HTTPS redirect
  |
  :8080     Frontend (nginx)
  |           - Serves React SPA
  |           - Proxies /api/* to backend
  |
  :3001     Backend (Bun + Hono)
  |           - Search API, image proxy, footprint/schematic SVGs
  |           - Connects to PostgreSQL
  |
  :5432     PostgreSQL 17
              - Full-text search (tsvector + pg_trgm)
              - 446k+ parts indexed
```

All services use `network_mode: host`, so they bind directly to the host network.

### Docker Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `db` | postgres:17-alpine | 5432 | PostgreSQL with tuned memory settings |
| `backend` | Custom (Bun) | 3001 | API server |
| `frontend` | Custom (nginx) | 8080 | Static SPA + reverse proxy to backend |
| `npm` | jc21/nginx-proxy-manager | 80, 443, 81 | SSL termination and proxy |
| `ingest` | Custom (Bun) | none | On-demand data ingestion (tools profile) |

### Docker Volumes

| Volume | Contents |
|--------|----------|
| `pg_data` | PostgreSQL database files |
| `img_cache` | Cached product images from LCSC CDN |
| `raw_data` | Downloaded raw data (jlcparts, JLCPCB API, datasheets) |
| `npm_data` | Nginx Proxy Manager configuration |
| `npm_letsencrypt` | Let's Encrypt certificates |

## Environment Variables

Copy `.env.example` to `.env` and configure each variable:

```bash
cp .env.example .env
```

### Database

| Variable | Description | Example |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | PostgreSQL password for the `jlc` user | `a-strong-random-password` |
| `DATABASE_URL` | Full PostgreSQL connection string | `postgres://jlc:a-strong-random-password@localhost:5432/jlc` |

The password in `DATABASE_URL` must match `POSTGRES_PASSWORD`.

### Backend

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend HTTP port | `3001` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | `http://localhost:3000` |

For production, set `ALLOWED_ORIGINS` to your domain: `https://your-domain.com`.

### Ingestion

| Variable | Description | Default |
|----------|-------------|---------|
| `JLCPARTS_BASE` | jlcparts mirror URL | `https://yaqwsx.github.io/jlcparts` |
| `INGEST_CONCURRENCY` | Number of parallel download workers | `4` |

### Deployment / SSL

| Variable | Description | Example |
|----------|-------------|---------|
| `DOMAIN` | Your public domain name | `search.example.com` |
| `NPM_ADMIN_EMAIL` | NPM admin login email | `admin@example.com` |
| `NPM_ADMIN_PASS` | NPM admin login password | `a-strong-password` |
| `LETSENCRYPT_EMAIL` | Email for Let's Encrypt certificate notifications | `you@example.com` |

### Frontend (build-time)

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_BASE` | API base URL baked into the frontend build | `""` (relative, uses nginx proxy) |

Normally leave `VITE_API_BASE` empty. The frontend nginx config proxies `/api/*` to the backend on port 3001.

## Manual Setup (Step by Step)

### 1. Clone the repository

```bash
git clone https://github.com/casimir-engineering/jlc-search.git
cd jlc-search
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:
- `POSTGRES_PASSWORD` -- a strong random password
- `DATABASE_URL` -- update the password to match
- `ALLOWED_ORIGINS` -- your production domain (`https://your-domain.com`)
- `DOMAIN` -- your domain name
- `LETSENCRYPT_EMAIL` -- for SSL certificate issuance

### 3. Build Docker images

```bash
docker compose build
```

### 4. Start services

```bash
docker compose up -d
```

Wait for the database health check to pass (takes a few seconds):

```bash
docker compose logs db --follow   # watch for "database system is ready to accept connections"
```

### 5. Run initial data ingestion

The first ingestion downloads the jlcparts mirror and populates the database. This takes roughly 15 minutes depending on your internet connection.

```bash
docker compose run --rm ingest
```

This runs the default ingest script which downloads jlcparts data and processes it into PostgreSQL.

For a more comprehensive ingestion including JLCPCB stock data and LCSC enrichment:

```bash
# Download all sources (no DB needed)
make download

# Process all downloaded data into PostgreSQL
make process
```

### 6. Verify the application

Open `http://your-server-ip:8080` in a browser. You should see the search interface. Try searching for a component like `100nF 0402`.

### 7. Configure SSL (see next section)

## SSL / HTTPS Setup

### Automated setup

The deploy script handles building, starting services, and opening firewall ports:

```bash
./deploy.sh
```

Then run the NPM auto-configuration script to create the proxy host and request an SSL certificate:

```bash
make configure-npm
```

This script will:
1. Create an admin user in NPM (first run only)
2. Create a proxy host forwarding your domain to `127.0.0.1:8080`
3. Request a Let's Encrypt certificate (if `LETSENCRYPT_EMAIL` is set in `.env`)
4. Enable Force SSL, HTTP/2, and HSTS

### Manual setup via NPM admin panel

1. Access the NPM admin UI:
   - Local server: `http://localhost:81`
   - Remote server: Set up an SSH tunnel first:
     ```bash
     ssh -L 81:localhost:81 user@your-server
     ```
     Then open `http://localhost:81`

2. Log in with default credentials: `admin@example.com` / `changeme` (change immediately)

3. Add a Proxy Host:
   - **Domain Names**: your domain (e.g., `search.example.com`)
   - **Scheme**: http
   - **Forward Hostname/IP**: `127.0.0.1`
   - **Forward Port**: `8080`
   - **Block Common Exploits**: enabled

4. In the **SSL** tab:
   - Request a new Let's Encrypt certificate
   - **Force SSL**: enabled
   - **HTTP/2 Support**: enabled
   - **HSTS Enabled**: enabled
   - Enter your email for Let's Encrypt notifications

5. Save and verify: `https://your-domain.com`

### Security note

Port 81 (NPM admin panel) is intentionally not exposed to the internet. Always access it via SSH tunnel on remote servers.

## Data Ingestion

### Data sources

jlc-search merges data from three sources:

| Source | What it provides | Download command | Process command |
|--------|-----------------|------------------|-----------------|
| jlcparts mirror | 446k+ parts, attributes, categories | `bun run ingest/src/download-jlcparts.ts` | `bun run ingest/src/process-jlcparts.ts` |
| JLCPCB API | JLCPCB stock levels, PCBA type info | `bun run ingest/src/download-jlcpcb.ts` | `bun run ingest/src/process-jlcpcb.ts` |
| LCSC API | Enriched descriptions, pricing, stock | `bun run ingest/src/download-lcsc.ts` | (merged during process-jlcpcb) |

### Ingestion via Docker

```bash
# Default: downloads jlcparts and processes into DB
docker compose run --rm ingest

# Run a specific script inside the ingest container
docker compose run --rm ingest ingest/src/download-jlcparts.ts
```

### Ingestion via Makefile (requires Bun installed locally)

```bash
# Download all sources (network only, no DB)
make download

# Process all downloaded data (needs PostgreSQL running)
make process

# Or run both together using Docker
make ingest
```

### Datasheet pipeline

The datasheet pipeline extracts searchable text from component datasheets:

```bash
# Full pipeline: export URLs -> download PDFs -> extract text -> process into DB
make datasheets

# Or run individual steps:
make export-datasheet-urls    # Export datasheet URLs from DB
make download-datasheets      # Download PDFs and extract text
make process-datasheets       # Process extracted text into DB
```

### Incremental updates

All ingestion scripts support incremental updates:
- **jlcparts**: Tracks file hashes; only re-processes changed categories
- **JLCPCB API**: Uses a page manifest; resumes interrupted downloads
- **LCSC enrichment**: Appends to NDJSON file; deduplicates on process
- **Datasheets**: Tracks extraction in `datasheet_meta`; skips already-processed files

All database writes use `ON CONFLICT (lcsc) DO UPDATE`, so any source can be re-run safely at any time.

## Maintenance

### Updating the application

```bash
cd /path/to/jlc-search
git pull
docker compose build
docker compose up -d
```

The database volume persists across rebuilds. No data is lost.

### Refreshing part data

```bash
# Re-run ingestion to pick up new parts
docker compose run --rm ingest

# Or for a full refresh from all sources
make download && make process
```

### Database backup

```bash
# Dump the database
docker compose exec db pg_dump -U jlc jlc > backup-$(date +%Y%m%d).sql

# Restore from backup
docker compose exec -T db psql -U jlc jlc < backup-20250101.sql
```

### Viewing logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f db
docker compose logs -f npm
```

### Restarting services

```bash
# Restart everything
docker compose restart

# Restart a single service
docker compose restart backend
```

### Disk usage

The main disk consumers are:
- PostgreSQL data volume (`pg_data`): ~2-3 GB
- Raw downloaded data (`raw_data`): ~5-10 GB
- Image cache (`img_cache`): grows over time as users browse parts

Check Docker volume sizes:

```bash
docker system df -v
```

## Troubleshooting

### Services fail to start

Check that no other process is using the required ports (5432, 3001, 8080, 80, 443, 81):

```bash
ss -tlnp | grep -E '(5432|3001|8080|80|443|81)'
```

### Database connection errors

Verify the database is healthy:

```bash
docker compose exec db pg_isready -U jlc
```

Verify `DATABASE_URL` in `.env` matches `POSTGRES_PASSWORD`:

```bash
# The password in this URL:
# DATABASE_URL=postgres://jlc:YOUR_PASSWORD@localhost:5432/jlc
# Must match:
# POSTGRES_PASSWORD=YOUR_PASSWORD
```

### NPM not responding on port 81

```bash
docker compose logs npm
docker compose restart npm
```

### SSL certificate not issuing

- Verify DNS: `host your-domain.com` should return your server's IP
- Verify port 80 is open: `curl -I http://your-domain.com`
- Check NPM logs: `docker compose logs npm`

### UFW / firewall issues

All Docker services use `network_mode: host`, which bypasses Docker's iptables rules. If you use UFW:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# Do NOT expose port 81 (NPM admin) -- use SSH tunnel instead
```

### Search returns no results

The database may be empty. Run ingestion:

```bash
docker compose run --rm ingest
```

Check part count:

```bash
docker compose exec db psql -U jlc -c "SELECT count(*) FROM parts;"
```

## Local Development

For development without Docker (except PostgreSQL):

```bash
# Start PostgreSQL
make pg

# Run backend and frontend with hot reload
make dev
```

Or run them separately:

```bash
make dev-backend    # Backend on port 3001
make dev-frontend   # Frontend on port 3000 (proxies /api to backend)
```

The frontend dev server (Vite) runs on port 3000 and proxies API requests to the backend on port 3001.
