/**
 * Export datasheet URLs from the database to an NDJSON file.
 * This keeps the download phase DB-free.
 *
 * Usage: bun run ingest/src/export-datasheet-urls.ts
 */
import postgres from "postgres";
import { writeFileSync } from "fs";
import { ensureRawDirs, datasheetUrlsPath } from "./storage.ts";
import type { DatasheetUrlEntry } from "./types.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jlc:jlc@localhost:5432/jlc";

async function main() {
  console.log("Exporting datasheet URLs from database...");
  ensureRawDirs();

  const sql = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });

  const rows = await sql`
    SELECT lcsc, datasheet, category, subcategory
    FROM parts
    WHERE datasheet IS NOT NULL
      AND datasheet != ''
      AND (stock > 0 OR jlc_stock > 0)
  `;

  const lines: string[] = [];
  for (const row of rows) {
    const entry: DatasheetUrlEntry = {
      lcsc: row.lcsc,
      url: row.datasheet,
      category: row.category,
      subcategory: row.subcategory,
    };
    lines.push(JSON.stringify(entry));
  }

  const destPath = datasheetUrlsPath();
  writeFileSync(destPath, lines.join("\n") + "\n");

  console.log(`Exported ${rows.length.toLocaleString()} datasheet URLs to ${destPath}`);
  await sql.end();
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
