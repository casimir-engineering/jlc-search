import { Hono } from "hono";
import { cors } from "hono/cors";
import { searchRouter } from "./routes/search.ts";
import { partRouter } from "./routes/part.ts";
import { statusRouter } from "./routes/status.ts";
import { imgRouter } from "./routes/img.ts";
import { fpRouter } from "./routes/fp.ts";
import { schRouter } from "./routes/sch.ts";
import { pcbaRouter } from "./routes/pcba.ts";
import { waitForDb, closeDb } from "./db.ts";

const app = new Hono();

// --- CORS: configurable via ALLOWED_ORIGINS, default to localhost:3000 ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(",").map(s => s.trim());
app.use("*", cors({
  origin: (origin) => allowedOrigins.includes("*") ? origin : (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
}));

// --- Security headers ---
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  // CSP: allow images and styles for API responses (SVGs, images)
  c.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'");
});

// --- Simple IP rate limiter: 200 searches/min per IP ---
const rateMap = new Map<string, { count: number; reset: number }>();
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT ?? "200");
const RATE_WINDOW_MS = 60_000;
app.use("/api/search", async (c, next) => {
  const ip = c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-bun-client-ip") ?? "unknown";
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + RATE_WINDOW_MS };
    rateMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) {
    c.header("Retry-After", "60");
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  // Periodic cleanup: every ~1000 requests, purge expired entries
  if (entry.count === 1 && rateMap.size > 10_000) {
    for (const [k, v] of rateMap) { if (now > v.reset) rateMap.delete(k); }
  }
  await next();
});

app.route("/api/search", searchRouter);
app.route("/api/parts", partRouter);
app.route("/api/status", statusRouter);
app.route("/api/img", imgRouter);
app.route("/api/fp", fpRouter);
app.route("/api/sch", schRouter);
app.route("/api/pcba", pcbaRouter);

app.get("/", (c) => c.json({ ok: true, service: "jlc-search" }));

const port = parseInt(process.env.PORT ?? "3001");

// Wait for DB schema before starting server
await waitForDb();

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req, server) {
    const addr = server.requestIP(req);
    if (addr) req.headers.set("x-bun-client-ip", addr.address);
    return app.fetch(req);
  },
  maxRequestBodySize: 64 * 1024,  // 64 KB — this is a search API, no large uploads
});

console.log(`Backend running on http://0.0.0.0:${server.port}`);

// Graceful shutdown
process.on("SIGINT", async () => {
  await closeDb();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeDb();
  process.exit(0);
});
