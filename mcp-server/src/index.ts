import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { register as registerSearchParts } from "./tools/search-parts.ts";
import { register as registerGetPart } from "./tools/get-part.ts";
import { register as registerListCategories } from "./tools/list-categories.ts";
import { register as registerCompareParts } from "./tools/compare-parts.ts";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3002", 10);

// ── MCP Server ──────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "jlc-search",
    version: "0.1.0",
  });

  registerSearchParts(server);
  registerGetPart(server);
  registerListCategories(server);
  registerCompareParts(server);

  return server;
}

// ── Hono App ────────────────────────────────────────────────────────

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "mcp-session-id",
      "Last-Event-ID",
      "mcp-protocol-version",
    ],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  })
);

// Health check
app.get("/health", (c) => c.json({ status: "ok", name: "jlc-search-mcp" }));

// MCP endpoint — stateless: new server + transport per request
app.post("/mcp", async (c) => {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const body = await c.req.json();
  const response = await transport.handleRequest(c.req.raw, { parsedBody: body });

  if (response) {
    return response;
  }
  return c.text("", 204);
});

// Handle GET for SSE (not used in stateless mode, but return proper error)
app.get("/mcp", (c) =>
  c.json({ error: "SSE not supported in stateless mode" }, 405)
);

// Handle DELETE for session termination (not used in stateless mode)
app.delete("/mcp", (c) =>
  c.json({ error: "Sessions not supported in stateless mode" }, 405)
);

// ── Start server ────────────────────────────────────────────────────

console.log(`jlc-search MCP server listening on port ${MCP_PORT}`);
console.log(`  Health:  http://localhost:${MCP_PORT}/health`);
console.log(`  MCP:     http://localhost:${MCP_PORT}/mcp`);

Bun.serve({
  port: MCP_PORT,
  fetch: app.fetch,
});
