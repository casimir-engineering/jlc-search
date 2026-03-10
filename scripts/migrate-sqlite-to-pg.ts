/**
 * One-shot migration: read all parts from SQLite → bulk insert into PostgreSQL.
 *
 * Usage: bun run scripts/migrate-sqlite-to-pg.ts
 *
 * Expects:
 *   - SQLite DB at data/parts.db (or DB_PATH env var)
 *   - PostgreSQL running (DATABASE_URL env var or default localhost)
 */
import { Database } from "bun:sqlite";
import postgres from "postgres";
import { applySchema } from "../backend/src/schema.ts";
import { extractNumericAttrs } from "../ingest/src/attrs.ts";

const DB_PATH = process.env.DB_PATH ?? "data/parts.db";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jlc:jlc@localhost:5432/jlc";

const CHUNK = 1000;
const NUM_CHUNK = 5000;

async function main() {
  console.log(`SQLite → PostgreSQL migration`);
  console.log(`  SQLite: ${DB_PATH}`);
  console.log(`  Postgres: ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);

  // Open SQLite
  const lite = new Database(DB_PATH, { readonly: true });
  const totalRow = lite.query("SELECT COUNT(*) AS cnt FROM parts").get() as { cnt: number };
  const totalParts = totalRow.cnt;
  console.log(`  Parts to migrate: ${totalParts.toLocaleString()}`);

  // Connect to PostgreSQL
  const sql = postgres(DATABASE_URL, { max: 10 });
  await applySchema(sql);

  // Check existing count
  const [existing] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const existingCount = Number(existing?.cnt ?? 0);
  if (existingCount > 0) {
    console.log(`  PostgreSQL already has ${existingCount.toLocaleString()} parts`);
  }

  // Disable trigger for bulk performance
  await sql`ALTER TABLE parts DISABLE TRIGGER trg_parts_search_vec`;

  // Stream all parts from SQLite
  const columns = [
    "lcsc", "mpn", "manufacturer", "category", "subcategory", "description",
    "datasheet", "package", "joints", "stock", "price_raw", "img", "url",
    "part_type", "pcba_type", "attributes", "search_text",
  ] as const;

  const insertCols = [...columns] as unknown as string[];

  const stmt = lite.query("SELECT * FROM parts");
  const allParts = stmt.all() as Record<string, unknown>[];

  let migrated = 0;

  for (let i = 0; i < allParts.length; i += CHUNK) {
    const chunk = allParts.slice(i, i + CHUNK);
    const rows = chunk.map((p) => ({
      lcsc: String(p.lcsc ?? ""),
      mpn: String(p.mpn ?? ""),
      manufacturer: p.manufacturer != null ? String(p.manufacturer) : null,
      category: String(p.category ?? ""),
      subcategory: String(p.subcategory ?? ""),
      description: String(p.description ?? ""),
      datasheet: p.datasheet != null ? String(p.datasheet) : null,
      package: p.package != null ? String(p.package) : null,
      joints: p.joints != null ? Number(p.joints) : null,
      stock: Number(p.stock ?? 0),
      price_raw: String(p.price_raw ?? ""),
      img: p.img != null ? String(p.img) : null,
      url: p.url != null ? String(p.url) : null,
      part_type: String(p.part_type ?? "Extended"),
      pcba_type: String(p.pcba_type ?? "Standard"),
      attributes: String(p.attributes ?? "{}"),
      search_text: String(p.search_text ?? ""),
    }));

    const valid = rows.filter((r) => r.lcsc);
    if (valid.length === 0) continue;

    await sql`
      INSERT INTO parts ${sql(valid, ...insertCols)}
      ON CONFLICT (lcsc) DO UPDATE SET
        mpn = EXCLUDED.mpn, manufacturer = EXCLUDED.manufacturer,
        category = EXCLUDED.category, subcategory = EXCLUDED.subcategory,
        description = EXCLUDED.description, datasheet = EXCLUDED.datasheet,
        package = EXCLUDED.package, joints = EXCLUDED.joints,
        stock = EXCLUDED.stock, price_raw = EXCLUDED.price_raw,
        img = EXCLUDED.img, url = EXCLUDED.url,
        part_type = EXCLUDED.part_type, pcba_type = EXCLUDED.pcba_type,
        attributes = EXCLUDED.attributes, search_text = EXCLUDED.search_text
    `;

    // Insert numeric attributes
    const lcscs = valid.map((r) => r.lcsc);
    await sql`DELETE FROM part_nums WHERE lcsc IN ${sql(lcscs)}`;

    const numRows: { lcsc: string; unit: string; value: number }[] = [];
    for (const r of valid) {
      for (const { unit, value } of extractNumericAttrs(r.attributes, r.description)) {
        numRows.push({ lcsc: r.lcsc, unit, value });
      }
    }
    if (numRows.length > 0) {
      for (let j = 0; j < numRows.length; j += NUM_CHUNK) {
        await sql`INSERT INTO part_nums ${sql(numRows.slice(j, j + NUM_CHUNK), "lcsc", "unit", "value")}`;
      }
    }

    migrated += valid.length;
    if (migrated % 10000 === 0 || migrated === totalParts) {
      const pct = ((migrated / totalParts) * 100).toFixed(1);
      console.log(`  ${migrated.toLocaleString()} / ${totalParts.toLocaleString()} (${pct}%)`);
    }
  }

  // Migrate ingest_meta if it exists
  try {
    const metaRows = lite.query("SELECT * FROM ingest_meta").all() as Record<string, unknown>[];
    if (metaRows.length > 0) {
      console.log(`  Migrating ${metaRows.length} ingest_meta rows...`);
      for (let i = 0; i < metaRows.length; i += CHUNK) {
        const chunk = metaRows.slice(i, i + CHUNK).map((m) => ({
          category: String(m.category),
          subcategory: String(m.subcategory),
          sourcename: String(m.sourcename),
          datahash: String(m.datahash),
          stockhash: String(m.stockhash),
          ingested_at: Number(m.ingested_at),
        }));
        await sql`
          INSERT INTO ingest_meta ${sql(chunk, "category", "subcategory", "sourcename", "datahash", "stockhash", "ingested_at")}
          ON CONFLICT (category, subcategory) DO UPDATE SET
            sourcename = EXCLUDED.sourcename,
            datahash = EXCLUDED.datahash,
            stockhash = EXCLUDED.stockhash,
            ingested_at = EXCLUDED.ingested_at
        `;
      }
    }
  } catch {
    console.log("  No ingest_meta table in SQLite, skipping.");
  }

  // Rebuild search vectors
  console.log("  Building search vectors...");
  await sql`
    UPDATE parts SET search_vec =
      setweight(to_tsvector('simple', coalesce(lcsc, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(mpn, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(manufacturer, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(subcategory, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(search_text, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(package, '')), 'D')
    WHERE search_vec IS NULL
  `;
  console.log("  Search vectors built.");

  // Re-enable trigger
  await sql`ALTER TABLE parts ENABLE TRIGGER trg_parts_search_vec`;

  // Final count
  const [finalRow] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const finalCount = Number(finalRow?.cnt ?? 0);
  const [numCount] = await sql`SELECT COUNT(*) AS cnt FROM part_nums`;

  console.log(`\n=== Migration Complete ===`);
  console.log(`  Parts migrated: ${finalCount.toLocaleString()}`);
  console.log(`  Numeric attrs: ${Number(numCount?.cnt ?? 0).toLocaleString()}`);

  lite.close();
  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
