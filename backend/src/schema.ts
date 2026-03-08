export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -65536;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS parts (
  lcsc         TEXT PRIMARY KEY NOT NULL,
  mpn          TEXT NOT NULL DEFAULT '',
  manufacturer TEXT,
  category     TEXT NOT NULL DEFAULT '',
  subcategory  TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  datasheet    TEXT,
  package      TEXT,
  joints       INTEGER,
  stock        INTEGER NOT NULL DEFAULT 0,
  price_raw    TEXT NOT NULL DEFAULT '',
  img          TEXT,
  url          TEXT,
  part_type    TEXT NOT NULL DEFAULT 'Extended',
  pcba_type    TEXT NOT NULL DEFAULT 'Standard',
  attributes   TEXT NOT NULL DEFAULT '{}',
  search_text  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_parts_mpn   ON parts(mpn);
CREATE INDEX IF NOT EXISTS idx_parts_type  ON parts(part_type);
CREATE INDEX IF NOT EXISTS idx_parts_stock ON parts(stock);
CREATE INDEX IF NOT EXISTS idx_parts_cat   ON parts(category, subcategory);

CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
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

CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, lcsc, mpn, manufacturer, description, package, subcategory, search_text)
  VALUES (new.rowid, new.lcsc, new.mpn, new.manufacturer, new.description, new.package, new.subcategory, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, lcsc, mpn, manufacturer, description, package, subcategory, search_text)
  VALUES ('delete', old.rowid, old.lcsc, old.mpn, old.manufacturer, old.description, old.package, old.subcategory, old.search_text);
END;

CREATE TRIGGER IF NOT EXISTS parts_au AFTER UPDATE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, lcsc, mpn, manufacturer, description, package, subcategory, search_text)
  VALUES ('delete', old.rowid, old.lcsc, old.mpn, old.manufacturer, old.description, old.package, old.subcategory, old.search_text);
  INSERT INTO parts_fts(rowid, lcsc, mpn, manufacturer, description, package, subcategory, search_text)
  VALUES (new.rowid, new.lcsc, new.mpn, new.manufacturer, new.description, new.package, new.subcategory, new.search_text);
END;

CREATE TABLE IF NOT EXISTS part_nums (
  lcsc  TEXT NOT NULL,
  unit  TEXT NOT NULL,
  value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_part_nums_unit_value ON part_nums(unit, value);
CREATE INDEX IF NOT EXISTS idx_part_nums_lcsc ON part_nums(lcsc);

CREATE TABLE IF NOT EXISTS ingest_meta (
  category    TEXT NOT NULL,
  subcategory TEXT NOT NULL,
  sourcename  TEXT NOT NULL,
  datahash    TEXT NOT NULL,
  stockhash   TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (category, subcategory)
);
`;
