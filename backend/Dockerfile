FROM oven/bun:1-slim AS base
WORKDIR /app

COPY backend/package.json ./
RUN bun install --frozen-lockfile

COPY backend/tsconfig.json ./
COPY backend/src/ ./src/

ENV PORT=3001
EXPOSE 3001

RUN addgroup --gid 1000 app && adduser --disabled-password --uid 1000 --ingroup app app
USER app

CMD ["bun", "run", "src/index.ts"]
