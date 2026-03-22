FROM oven/bun:1-slim AS base
WORKDIR /app

# Install MCP server dependencies
COPY mcp-server/package.json ./mcp-server/
RUN cd mcp-server && bun install

# Copy MCP server source
COPY mcp-server/tsconfig.json ./mcp-server/
COPY mcp-server/src/ ./mcp-server/src/

# Copy backend source (needed for shared type imports and schema)
COPY backend/package.json ./backend/
RUN cd backend && bun install
COPY backend/tsconfig.json ./backend/
COPY backend/src/ ./backend/src/

ENV MCP_PORT=3002
EXPOSE 3002

USER bun

CMD ["bun", "run", "mcp-server/src/index.ts"]
