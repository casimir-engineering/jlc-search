FROM oven/bun:1-slim AS base
WORKDIR /app

COPY backend/package.json ./
RUN bun install --frozen-lockfile

COPY backend/tsconfig.json ./
COPY backend/src/ ./src/

ENV PORT=3001
ENV DATABASE_URL=postgres://jst:jst@localhost:5432/jst
EXPOSE 3001

CMD ["bun", "run", "src/index.ts"]
