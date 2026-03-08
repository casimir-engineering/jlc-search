// Rebuild FTS5 index with updated schema (7 columns including search_text)
import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "../../data/parts.db");

const db = new Database(DB_PATH);

console.log("Dropping old FTS5 table and triggers...");
db.exec(`
  DROP TRIGGER IF EXISTS parts_ai;
  DROP TRIGGER IF EXISTS parts_ad;
  DROP TRIGGER IF EXISTS parts_au;
  DROP TABLE IF EXISTS parts_fts;
`);

console.log("Creating new FTS5 table with search_text...");
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

console.log("Rebuilding FTS5 index from parts table...");
db.exec("INSERT INTO parts_fts(parts_fts) VALUES ('rebuild')");
console.log("FTS5 rebuild done.");

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

console.log("Done!");
db.close();
