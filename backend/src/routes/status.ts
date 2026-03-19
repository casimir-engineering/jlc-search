import { Hono } from "hono";
import { getSql } from "../db.ts";

export const statusRouter = new Hono();

statusRouter.get("/categories", async (c) => {
  const sql = getSql();
  const rows = await sql`
    SELECT category, COUNT(*) AS cnt
    FROM parts
    GROUP BY category
    HAVING COUNT(*) >= 10
    ORDER BY cnt DESC
  `;
  return c.json(rows.map((r) => ({ name: r.category, count: Number(r.cnt) })));
});

statusRouter.get("/", async (c) => {
  const sql = getSql();

  const [[countRow], [metaRow], [sizeRow]] = await Promise.all([
    sql`SELECT reltuples::bigint AS cnt FROM pg_class WHERE relname = 'parts'`,
    sql`SELECT COUNT(*) AS cnt, MAX(ingested_at) AS max_ts FROM ingest_meta`,
    sql`SELECT pg_database_size(current_database()) AS size_bytes`,
  ]);

  return c.json({
    total_parts: Number(countRow?.cnt ?? 0),
    last_ingested: metaRow?.max_ts
      ? new Date(Number(metaRow.max_ts) * 1000).toISOString()
      : null,
    categories_count: Number(metaRow?.cnt ?? 0),
    db_size_bytes: Number(sizeRow?.size_bytes ?? 0),
  });
});
