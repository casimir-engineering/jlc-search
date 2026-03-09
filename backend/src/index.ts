import { Hono } from "hono";
import { cors } from "hono/cors";
import { searchRouter } from "./routes/search.ts";
import { partRouter } from "./routes/part.ts";
import { statusRouter } from "./routes/status.ts";
import { imgRouter } from "./routes/img.ts";
import { fpRouter } from "./routes/fp.ts";
import { pcbaRouter } from "./routes/pcba.ts";
import { waitForDb, closeDb } from "./db.ts";

const app = new Hono();

app.use("*", cors({ origin: "*" }));

app.route("/api/search", searchRouter);
app.route("/api/parts", partRouter);
app.route("/api/status", statusRouter);
app.route("/api/img", imgRouter);
app.route("/api/fp", fpRouter);
app.route("/api/pcba", pcbaRouter);

app.get("/", (c) => c.json({ ok: true, service: "jst-search" }));

const port = parseInt(process.env.PORT ?? "3001");

// Wait for DB schema before starting server
await waitForDb();

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
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
