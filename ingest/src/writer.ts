import { Database } from "bun:sqlite";
import type { PartRow, StockData } from "./types.ts";

const INSERT_SQL = `
  INSERT OR REPLACE INTO parts
    (lcsc, mpn, manufacturer, category, subcategory, description,
     datasheet, package, joints, stock, price_raw, img, url, part_type, pcba_type, attributes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Drop FTS triggers for fast bulk insert. Call rebuildFts() afterward. */
export function dropFtsTriggers(db: Database): void {
  db.run("DROP TRIGGER IF EXISTS parts_ai");
  db.run("DROP TRIGGER IF EXISTS parts_ad");
  db.run("DROP TRIGGER IF EXISTS parts_au");
}

/** Re-create FTS triggers for incremental updates. */
export function recreateFtsTriggers(db: Database): void {
  db.run(`CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
    INSERT INTO parts_fts(rowid, lcsc, mpn, manufacturer, description, package, subcategory)
    VALUES (new.rowid, new.lcsc, new.mpn, new.manufacturer, new.description, new.package, new.subcategory);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
    INSERT INTO parts_fts(parts_fts, rowid, lcsc, mpn, manufacturer, description, package, subcategory)
    VALUES ('delete', old.rowid, old.lcsc, old.mpn, old.manufacturer, old.description, old.package, old.subcategory);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS parts_au AFTER UPDATE ON parts BEGIN
    INSERT INTO parts_fts(parts_fts, rowid, lcsc, mpn, manufacturer, description, package, subcategory)
    VALUES ('delete', old.rowid, old.lcsc, old.mpn, old.manufacturer, old.description, old.package, old.subcategory);
    INSERT INTO parts_fts(rowid, lcsc, mpn, manufacturer, description, package, subcategory)
    VALUES (new.rowid, new.lcsc, new.mpn, new.manufacturer, new.description, new.package, new.subcategory);
  END`);
}

/** Bulk insert parts in chunks of 1000, using a transaction per chunk. */
export function bulkInsertParts(db: Database, parts: PartRow[]): void {
  const stmt = db.prepare(INSERT_SQL);
  const CHUNK = 1000;
  for (let i = 0; i < parts.length; i += CHUNK) {
    const chunk = parts.slice(i, i + CHUNK);
    db.transaction(() => {
      for (const p of chunk) {
        // Use positional params; coerce undefined→null for every field
        const n = (v: unknown) => (v === undefined ? null : v);
        stmt.run(
          n(p.lcsc), n(p.mpn), n(p.manufacturer), n(p.category), n(p.subcategory),
          n(p.description), n(p.datasheet), n(p.package), n(p.joints), n(p.stock),
          n(p.price_raw), n(p.img), n(p.url), n(p.part_type), n(p.pcba_type), n(p.attributes)
        );
      }
    })();
  }
}

/** Update only the stock column for a set of LCSC codes. */
export function bulkUpdateStock(db: Database, stockData: StockData): void {
  const stmt = db.prepare("UPDATE parts SET stock = ? WHERE lcsc = ?");
  const entries = Object.entries(stockData);
  const CHUNK = 5000;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    db.transaction(() => {
      for (const [lcsc, stock] of chunk) {
        const normalizedLcsc = lcsc.toUpperCase().startsWith("C") ? lcsc.toUpperCase() : `C${lcsc}`.toUpperCase();
        stmt.run(stock, normalizedLcsc);
      }
    })();
  }
}

/** Rebuild the FTS5 index from the current content of the parts table. */
export function rebuildFts(db: Database): void {
  console.log("  Rebuilding FTS5 index...");
  db.run("INSERT INTO parts_fts(parts_fts) VALUES ('rebuild')");
  console.log("  FTS5 rebuild complete.");
}
