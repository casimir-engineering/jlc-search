.PHONY: dev ingest build up down logs

# Development: run backend and frontend locally (no Docker)
dev:
	@echo "Starting backend and frontend in dev mode..."
	@cd backend && bun install && bun run dev &
	@cd frontend && npm install && npm run dev

# Run ingest in Docker (uses existing parts_data volume)
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
