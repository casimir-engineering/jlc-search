/**
 * One-shot migration: backfill search_text for all existing parts.
 * 1. Add search_text column if missing
 * 2. Batch-read parts, generate search_text from attributes JSON
 * 3. Batch-update with transactions
 * 4. Drop + rebuild FTS5 with 7-column schema
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { buildSearchText } from "./attrs.ts";

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "../../data/parts.db");

console.log(`Opening database: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

// Step 1: Add column if it doesn't exist
try {
  db.exec("ALTER TABLE parts ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
  console.log("Added search_text column.");
} catch (e: unknown) {
  if (e instanceof Error && e.message.includes("duplicate column")) {
    console.log("search_text column already exists.");
  } else {
    throw e;
  }
}

// Step 2: Batch-read and update
const BATCH = 5000;
const totalRow = db.query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM parts").get();
const total = totalRow?.cnt ?? 0;
console.log(`Processing ${total} parts...`);

const selectStmt = db.query<{ lcsc: string; attributes: string }, [number, number]>(
  "SELECT lcsc, attributes FROM parts LIMIT ? OFFSET ?"
);
const updateStmt = db.prepare("UPDATE parts SET search_text = ? WHERE lcsc = ?");

let processed = 0;
let enriched = 0;

for (let offset = 0; offset < total; offset += BATCH) {
  const rows = selectStmt.all(BATCH, offset);

  db.transaction(() => {
    for (const row of rows) {
      const text = buildSearchText(row.attributes);
      if (text) {
        updateStmt.run(text, row.lcsc);
        enriched++;
      }
      processed++;
    }
  })();

  const pct = ((processed / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${processed}/${total} (${pct}%) — ${enriched} enriched`);
}
console.log();

// Step 3: Rebuild FTS5 with new schema
console.log("Dropping old FTS5 table and triggers...");
db.exec(`
  DROP TRIGGER IF EXISTS parts_ai;
  DROP TRIGGER IF EXISTS parts_ad;
  DROP TRIGGER IF EXISTS parts_au;
  DROP TABLE IF EXISTS parts_fts;
`);

console.log("Creating FTS5 with search_text column...");
db.exec(`
  CREATE VIRTUAL TABLE parts_fts USING fts5(
    lcsc,
    mpn,
    manufacturer,
    description,
    package,
    subcategory,
    search_text,
    content='parts',
    content_rowid='rowid',
    tokenize='unicode61 tokenchars ''-'''
  );
`);

console.log("Rebuilding FTS5 index...");
db.exec("INSERT INTO parts_fts(parts_fts) VALUES ('rebuild')");

console.log("Re-creating triggers...");
db.exec(`
  CREATE TRIGGER parts_ai AFTER INSERT ON parts BEGIN
    INSERT INTO parts_fts(rowid, lcsc, mpn, manufacturer, description, package, subcategory, search_text)
    VALUES (new.rowid, new.lcsc, new.mpn, new.manufacturer, new.description, new.package, new.subcategory, new.search_text);
  END;
  CREATE TRIGGER parts_ad AFTER DELETE ON parts BEGIN
    INSERT INTO parts_fts(parts_fts, rowid, lcsc, mpn, manufacturer, description, package, subcategory, search_text)
    VALUES ('delete', old.rowid, old.lcsc, old.mpn, old.manufacturer, old.description, old.package, old.subcategory, old.search_text);
  END;
  CREATE TRIGGER parts_au AFTER UPDATE ON parts BEGIN
    INSERT INTO parts_fts(parts_fts, rowid, lcsc, mpn, manufacturer, description, package, subcategory, search_text)
    VALUES ('delete', old.rowid, old.lcsc, old.mpn, old.manufacturer, old.description, old.package, old.subcategory, old.search_text);
    INSERT INTO parts_fts(rowid, lcsc, mpn, manufacturer, description, package, subcategory, search_text)
    VALUES (new.rowid, new.lcsc, new.mpn, new.manufacturer, new.description, new.package, new.subcategory, new.search_text);
  END;
`);

console.log(`\nDone! ${enriched}/${total} parts enriched with search_text.`);
db.close();
