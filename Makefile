.PHONY: dev dev-backend dev-frontend pg ingest download process build up down logs migrate deploy configure-npm prod export-datasheet-urls download-datasheets process-datasheets datasheets

# Start PostgreSQL for local development
pg:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example to .env and set POSTGRES_PASSWORD + DATABASE_URL"; exit 1; }
	docker compose up db -d
	@echo "PostgreSQL running on localhost:5432"

# Development: run backend and frontend locally (needs pg running)
dev: pg
	@echo "Starting backend and frontend in dev mode..."
	@set -a && . ./.env && set +a && cd backend && bun install && bun run dev &
	@cd frontend && npm install && npm run dev

dev-backend: pg
	set -a && . ./.env && set +a && cd backend && bun run src/index.ts

dev-frontend:
	cd frontend && npm run dev

# Migrate SQLite data to PostgreSQL
migrate: pg
	bun run scripts/migrate-sqlite-to-pg.ts

# Download only (no DB needed)
download:
	bun run ingest/src/download-jlcparts.ts
	bun run ingest/src/download-jlcpcb.ts
	bun run ingest/src/download-lcsc.ts

# Process only (needs pg running, assumes raw data exists)
process: pg
	bun run ingest/src/process-jlcparts.ts
	bun run ingest/src/process-jlcpcb.ts

# Datasheet pipeline: export URLs from DB, download+extract, process
export-datasheet-urls: pg
	bun run ingest/src/export-datasheet-urls.ts

download-datasheets:
	bun run ingest/src/download-datasheets.ts

process-datasheets: pg
	bun run ingest/src/process-datasheets.ts

datasheets: export-datasheet-urls download-datasheets process-datasheets

# Run ingest in Docker
ingest:
	docker compose run --rm ingest

# Build all Docker images
build:
	docker compose build

# Start all services
up:
	docker compose up -d

# Stop all services
down:
	docker compose down

# View logs
logs:
	docker compose logs -f

# Deploy to production (build, start, open firewall)
deploy:
	./deploy.sh

# Configure NPM proxy host + SSL (run once after first deploy)
configure-npm:
	@test -f .env || { echo "ERROR: .env not found"; exit 1; }
	@set -a && . ./.env && set +a && bash scripts/configure-npm.sh

# Production: build and start all services
prod: build up
	@echo "All services running. Run 'make configure-npm' for first-time NPM setup."
