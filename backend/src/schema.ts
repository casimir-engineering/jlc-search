import type { Sql } from "postgres";

/** Apply the full PostgreSQL schema (idempotent). */
export async function applySchema(sql: Sql): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  await sql`
    CREATE TABLE IF NOT EXISTS parts (
      lcsc         TEXT PRIMARY KEY,
      mpn          TEXT NOT NULL DEFAULT '',
      manufacturer TEXT,
      category     TEXT NOT NULL DEFAULT '',
      subcategory  TEXT NOT NULL DEFAULT '',
      description  TEXT NOT NULL DEFAULT '',
      datasheet    TEXT,
      package      TEXT,
      joints       INTEGER,
      moq          INTEGER,
      stock        INTEGER NOT NULL DEFAULT 0,
      price_raw    TEXT NOT NULL DEFAULT '',
      img          TEXT,
      url          TEXT,
      part_type    TEXT NOT NULL DEFAULT 'Extended',
      pcba_type    TEXT NOT NULL DEFAULT 'Standard',
      attributes   JSONB NOT NULL DEFAULT '{}',
      search_text  TEXT NOT NULL DEFAULT '',
      search_vec   tsvector
    )
  `;

  // Add full_text column for trigram substring search
  await sql`
    DO $$ BEGIN
      ALTER TABLE parts ADD COLUMN full_text TEXT NOT NULL DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Indexes
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_search ON parts USING GIN(search_vec)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_mpn_trgm ON parts USING GIN(mpn gin_trgm_ops)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_mfr_trgm ON parts USING GIN(manufacturer gin_trgm_ops)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_fulltext_trgm ON parts USING GIN(full_text gin_trgm_ops)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_mpn ON parts(mpn)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_type ON parts(part_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_stock ON parts(stock)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_cat ON parts(category, subcategory)`;

  // tsvector trigger function
  await sql`
    CREATE OR REPLACE FUNCTION update_search_vec() RETURNS trigger AS $$
    BEGIN
      NEW.search_vec :=
        setweight(to_tsvector('simple', coalesce(NEW.lcsc, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.mpn, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.manufacturer, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.subcategory, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(NEW.search_text, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(NEW.package, '')), 'D');
      NEW.full_text := lower(concat_ws(' ', NEW.lcsc, NEW.mpn,
        coalesce(NEW.manufacturer, ''), NEW.description,
        coalesce(NEW.subcategory, ''), coalesce(NEW.search_text, ''),
        coalesce(NEW.package, '')));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `;

  // Create trigger if not exists (use DO block)
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_parts_search_vec'
      ) THEN
        CREATE TRIGGER trg_parts_search_vec
          BEFORE INSERT OR UPDATE ON parts
          FOR EACH ROW EXECUTE FUNCTION update_search_vec();
      END IF;
    END $$
  `;

  // Numeric attributes table
  await sql`
    CREATE TABLE IF NOT EXISTS part_nums (
      lcsc  TEXT NOT NULL REFERENCES parts(lcsc) ON DELETE CASCADE,
      unit  TEXT NOT NULL,
      value DOUBLE PRECISION NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_pn_unit_value ON part_nums(unit, value)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pn_lcsc ON part_nums(lcsc)`;

  // Ingest metadata
  await sql`
    CREATE TABLE IF NOT EXISTS ingest_meta (
      category    TEXT NOT NULL,
      subcategory TEXT NOT NULL,
      sourcename  TEXT NOT NULL,
      datahash    TEXT NOT NULL,
      stockhash   TEXT NOT NULL,
      ingested_at BIGINT NOT NULL,
      PRIMARY KEY (category, subcategory)
    )
  `;
}
