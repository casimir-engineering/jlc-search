.PHONY: dev dev-backend dev-frontend pg ingest build up down logs migrate

# Start PostgreSQL for local development
pg:
	docker compose up db -d
	@echo "PostgreSQL running on localhost:5432"

# Development: run backend and frontend locally (needs pg running)
dev: pg
	@echo "Starting backend and frontend in dev mode..."
	@cd backend && bun install && bun run dev &
	@cd frontend && npm install && npm run dev

dev-backend: pg
	cd backend && bun run src/index.ts

dev-frontend:
	cd frontend && npm run dev

# Migrate SQLite data to PostgreSQL
migrate: pg
	bun run scripts/migrate-sqlite-to-pg.ts

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
