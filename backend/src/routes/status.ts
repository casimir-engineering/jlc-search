import { Hono } from "hono";
import { getSql } from "../db.ts";

export const statusRouter = new Hono();

statusRouter.get("/", async (c) => {
  const sql = getSql();

  const [countRow] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const [metaRow] = await sql`SELECT MAX(ingested_at) AS max_ts FROM ingest_meta`;
  const [catRow] = await sql`SELECT COUNT(*) AS cnt FROM ingest_meta`;
  const [sizeRow] = await sql`SELECT pg_database_size(current_database()) AS size_bytes`;

  return c.json({
    total_parts: Number(countRow?.cnt ?? 0),
    last_ingested: metaRow?.max_ts
      ? new Date(Number(metaRow.max_ts) * 1000).toISOString()
      : null,
    categories_count: Number(catRow?.cnt ?? 0),
    db_size_bytes: Number(sizeRow?.size_bytes ?? 0),
  });
});
