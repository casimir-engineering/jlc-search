FROM oven/bun:1-slim AS base
WORKDIR /app

COPY backend/package.json ./
RUN bun install --frozen-lockfile

COPY backend/tsconfig.json ./
COPY backend/src/ ./src/

ENV PORT=3001
EXPOSE 3001

CMD ["bun", "run", "src/index.ts"]
