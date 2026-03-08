import { Hono } from "hono";
import { getDb } from "../db.ts";
import { statSync } from "fs";
import { join } from "path";

export const statusRouter = new Hono();

statusRouter.get("/", (c) => {
  const db = getDb();

  const countRow = db.query<{ cnt: number }, []>(
    "SELECT COUNT(*) AS cnt FROM parts"
  ).get();

  const metaRow = db.query<{ max_ts: number | null }, []>(
    "SELECT MAX(ingested_at) AS max_ts FROM ingest_meta"
  ).get();

  const catRow = db.query<{ cnt: number }, []>(
    "SELECT COUNT(*) AS cnt FROM ingest_meta"
  ).get();

  const dbPath = process.env.DB_PATH ?? join(import.meta.dir, "../../../data/parts.db");
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    // ignore
  }

  return c.json({
    total_parts: countRow?.cnt ?? 0,
    last_ingested: metaRow?.max_ts
      ? new Date(metaRow.max_ts * 1000).toISOString()
      : null,
    categories_count: catRow?.cnt ?? 0,
    db_size_bytes: dbSizeBytes,
  });
});
