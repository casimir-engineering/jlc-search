FROM oven/bun:1-slim AS base
WORKDIR /app

# System dependencies for PDF text extraction
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*

# Copy ingest package
COPY ingest/package.json ./ingest/
RUN cd ingest && bun install --frozen-lockfile

# Copy backend source (ingest imports schema from backend)
COPY backend/src/ ./backend/src/

# Copy ingest source
COPY ingest/tsconfig.json ./ingest/
COPY ingest/src/ ./ingest/src/

ENV JLCPARTS_BASE=https://yaqwsx.github.io/jlcparts
ENV INGEST_CONCURRENCY=4

RUN addgroup --gid 1000 app && adduser --disabled-password --uid 1000 --ingroup app app
USER app

ENTRYPOINT ["bun", "run"]
CMD ["ingest/src/ingest.ts"]
