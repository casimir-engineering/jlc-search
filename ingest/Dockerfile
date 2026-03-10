FROM oven/bun:1-slim AS base
WORKDIR /app

# Copy ingest package
COPY ingest/package.json ./ingest/
RUN cd ingest && bun install --frozen-lockfile

# Copy backend source (ingest imports schema from backend)
COPY backend/src/ ./backend/src/

# Copy ingest source
COPY ingest/tsconfig.json ./ingest/
COPY ingest/src/ ./ingest/src/

ENV DATABASE_URL=postgres://jlc:jlc@localhost:5432/jlc
ENV JLCPARTS_BASE=https://yaqwsx.github.io/jlcparts
ENV INGEST_CONCURRENCY=4

CMD ["bun", "run", "ingest/src/ingest.ts"]
