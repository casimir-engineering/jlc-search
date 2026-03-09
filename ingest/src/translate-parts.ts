/**
 * One-shot migration: translate Chinese terms in mpn and package columns.
 * Also rebuilds the FTS5 index after updating.
 *
 * Usage: bun run ingest/src/translate-parts.ts
 */
import { Database } from "bun:sqlite";
import { translateChinese } from "./chinese-dict.ts";

const DB_PATH = process.env.DB_PATH ?? "data/parts.db";
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

// Fetch parts with Chinese in mpn or package
const rows = db.query<{ lcsc: string; mpn: string; package: string | null }, []>(
  "SELECT lcsc, mpn, package FROM parts WHERE mpn GLOB '*[一-龥]*' OR package GLOB '*[一-龥]*'"
).all();

console.log(`Found ${rows.length} parts with Chinese text`);

const updateStmt = db.prepare("UPDATE parts SET mpn = ?, package = ? WHERE lcsc = ?");
let updated = 0;

const CHUNK = 5000;
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  db.transaction(() => {
    for (const r of chunk) {
      const newMpn = translateChinese(r.mpn);
      const newPkg = translateChinese(r.package ?? "");
      if (newMpn !== r.mpn || newPkg !== (r.package ?? "")) {
        updateStmt.run(newMpn, newPkg || null, r.lcsc);
        updated++;
      }
    }
  })();
  console.log(`  Processed ${Math.min(i + CHUNK, rows.length)} / ${rows.length}`);
}

console.log(`Updated ${updated} parts`);

// Check for any remaining Chinese characters (untranslated terms)
const remaining = db.query<{ lcsc: string; mpn: string; package: string | null }, []>(
  "SELECT lcsc, mpn, package FROM parts WHERE mpn GLOB '*[一-龥]*' OR package GLOB '*[一-龥]*'"
).all();

if (remaining.length > 0) {
  const missed = new Map<string, number>();
  for (const r of remaining) {
    const text = `${r.mpn} ${r.package ?? ""}`;
    const matches = text.match(/[\u4e00-\u9fff]+/g);
    if (matches) {
      for (const m of matches) {
        missed.set(m, (missed.get(m) || 0) + 1);
      }
    }
  }
  console.log(`\nWarning: ${remaining.length} parts still have Chinese text.`);
  console.log("Untranslated terms:");
  const sorted = [...missed.entries()].sort((a, b) => b[1] - a[1]);
  for (const [term, count] of sorted) {
    console.log(`  ${count}x  ${term}`);
  }
} else {
  console.log("All Chinese text translated successfully.");
}

// Rebuild FTS5 index
console.log("\nRebuilding FTS5 index...");
db.run("INSERT INTO parts_fts(parts_fts) VALUES ('rebuild')");
console.log("FTS5 rebuild complete.");
