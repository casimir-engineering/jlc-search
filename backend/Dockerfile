FROM oven/bun:1-slim AS base
WORKDIR /app

COPY backend/package.json ./
RUN bun install

COPY backend/tsconfig.json ./
COPY backend/src/ ./src/

RUN mkdir -p /app/data/img && chown -R bun:bun /app/data

ENV PORT=3001
EXPOSE 3001

USER bun

CMD ["bun", "run", "src/index.ts"]
