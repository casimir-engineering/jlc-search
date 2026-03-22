import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { register as registerSearchParts } from "./tools/search-parts.ts";
import { register as registerGetPart } from "./tools/get-part.ts";
import { register as registerListCategories } from "./tools/list-categories.ts";
import { register as registerCompareParts } from "./tools/compare-parts.ts";
import { register as registerCreateBom } from "./tools/create-bom.ts";

import { authMiddleware } from "./auth.ts";
import { handlePatreonWebhook, handleKeyPage } from "./patreon.ts";
import { logUsage } from "./usage.ts";
import { checkDailyLimit } from "./rate-limit.ts";
import { closeDb } from "./db.ts";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3002", 10);

// ── MCP Server ──────────────────────────────────────────────────────

function createMcpServer(apiKeyId?: string): McpServer {
  const server = new McpServer({
    name: "jlc-search",
    version: "0.1.0",
  });

  // Wrap each tool registration so we can intercept calls for usage logging
  const origRegisterTool = server.registerTool.bind(server);

  server.registerTool = function (name: string, config: any, handler: any) {
    const wrappedHandler = async (...args: any[]) => {
      const start = Date.now();
      let error: string | undefined;
      let resultCount: number | undefined;

      try {
        const result = await handler(...args);

        // Try to extract a result count from the content
        if (result?.content) {
          const textContent = result.content.find((c: any) => c.type === "text");
          if (textContent?.text) {
            const match = textContent.text.match(/^Found ([\d,]+) parts/);
            if (match) {
              resultCount = parseInt(match[1].replace(/,/g, ""), 10);
            }
          }
        }

        if (result?.isError) {
          const textContent = result.content?.find((c: any) => c.type === "text");
          error = textContent?.text?.slice(0, 200);
        }

        return result;
      } catch (err) {
        error = err instanceof Error ? err.message.slice(0, 200) : "Unknown error";
        throw err;
      } finally {
        const tookMs = Date.now() - start;
        if (apiKeyId) {
          logUsage(apiKeyId, name, tookMs, resultCount, error);
        }
      }
    };

    return origRegisterTool(name, config, wrappedHandler);
  } as typeof server.registerTool;

  registerSearchParts(server);
  registerGetPart(server);
  registerListCategories(server);
  registerCompareParts(server);
  registerCreateBom(server);

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

// Auth middleware — skips public paths internally
app.use("*", authMiddleware);

// Health check (public)
app.get("/health", (c) => c.json({ status: "ok", name: "jlc-search-mcp" }));

// Patreon webhook (public — signature verified internally)
app.post("/webhooks/patreon", handlePatreonWebhook);

// OAuth key retrieval page (public)
app.get("/key", handleKeyPage);

// MCP endpoint — stateless: new server + transport per request
app.post("/mcp", async (c) => {
  const apiKey = c.get("apiKey") as { id: string; tier: string; name: string } | undefined;

  // Check daily rate limit for authenticated requests that are tool calls
  if (apiKey) {
    const body = await c.req.json();

    if (body?.method === "tools/call") {
      const { allowed, remaining, limit } = await checkDailyLimit(apiKey.id, apiKey.tier);
      if (!allowed) {
        return c.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: {
            code: -32000,
            message: `Daily limit reached (${limit} calls/day for ${apiKey.tier} tier). Resets at midnight UTC.`,
          },
        }, 429);
      }
      c.header("X-RateLimit-Remaining", String(remaining));
      c.header("X-RateLimit-Limit", String(limit));
    }

    const server = createMcpServer(apiKey.id);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw, { parsedBody: body });
    return response ?? c.text("", 204);
  }

  // Unauthenticated (auth disabled) — no rate limiting
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  const body = await c.req.json();
  const response = await transport.handleRequest(c.req.raw, { parsedBody: body });
  return response ?? c.text("", 204);
});

// Handle GET for SSE (stateless mode — no streaming sessions)
app.get("/mcp", (c) =>
  c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null }, 405)
);

// Handle DELETE for session termination (stateless mode)
app.delete("/mcp", (c) =>
  c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Sessions not supported in stateless mode" }, id: null }, 405)
);

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);
  closeDb()
    .then(() => {
      console.log("Database connections closed.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error closing database:", err);
      process.exit(1);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Start server ────────────────────────────────────────────────────

const authEnabled = process.env.MCP_REQUIRE_AUTH === "true";
console.log(`jlc-search MCP server listening on port ${MCP_PORT}`);
console.log(`  Health:  http://localhost:${MCP_PORT}/health`);
console.log(`  MCP:     http://localhost:${MCP_PORT}/mcp`);
console.log(`  Key:     http://localhost:${MCP_PORT}/key`);
console.log(`  Auth:    ${authEnabled ? "ENABLED" : "disabled (set MCP_REQUIRE_AUTH=true to enable)"}`);

Bun.serve({
  port: MCP_PORT,
  fetch: app.fetch,
});
