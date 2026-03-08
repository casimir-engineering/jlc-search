/**
 * One-shot migration: populate part_nums table from attributes JSON.
 * Creates the table if needed, then batch-extracts numeric attributes.
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { extractNumericAttrs } from "./attrs.ts";

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "../../data/parts.db");

console.log(`Opening database: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

// Create table
db.exec(`
  CREATE TABLE IF NOT EXISTS part_nums (
    lcsc  TEXT NOT NULL,
    unit  TEXT NOT NULL,
    value REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_part_nums_unit_value ON part_nums(unit, value);
  CREATE INDEX IF NOT EXISTS idx_part_nums_lcsc ON part_nums(lcsc);
`);

// Clear existing data for fresh rebuild
db.exec("DELETE FROM part_nums");

const BATCH = 5000;
const totalRow = db.query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM parts").get();
const total = totalRow?.cnt ?? 0;
console.log(`Processing ${total} parts...`);

const selectStmt = db.query<{ lcsc: string; attributes: string }, [number, number]>(
  "SELECT lcsc, attributes FROM parts LIMIT ? OFFSET ?"
);
const insertStmt = db.prepare("INSERT INTO part_nums (lcsc, unit, value) VALUES (?, ?, ?)");

let processed = 0;
let inserted = 0;

for (let offset = 0; offset < total; offset += BATCH) {
  const rows = selectStmt.all(BATCH, offset);

  db.transaction(() => {
    for (const row of rows) {
      const nums = extractNumericAttrs(row.attributes);
      for (const { unit, value } of nums) {
        insertStmt.run(row.lcsc, unit, value);
        inserted++;
      }
      processed++;
    }
  })();

  const pct = ((processed / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${processed}/${total} (${pct}%) — ${inserted} numeric attrs`);
}

console.log(`\n\nDone! Inserted ${inserted} numeric attribute rows for ${total} parts.`);

// Show distribution
const stats = db.query<{ unit: string; cnt: number }, []>(
  "SELECT unit, COUNT(*) as cnt FROM part_nums GROUP BY unit ORDER BY cnt DESC"
).all();
console.log("\nUnit distribution:");
for (const s of stats) {
  console.log(`  ${s.unit}: ${s.cnt}`);
}

db.close();
