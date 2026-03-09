import type postgres from "postgres";
import type { PartRow, StockData } from "./types.ts";
import { extractNumericAttrs } from "./attrs.ts";

type Sql = ReturnType<typeof postgres>;

const COLUMNS = [
  "lcsc", "mpn", "manufacturer", "category", "subcategory", "description",
  "datasheet", "package", "joints", "stock", "price_raw", "img", "url",
  "part_type", "pcba_type", "attributes", "search_text",
] as const;

/** Bulk upsert parts in chunks. Also inserts numeric attributes. */
export async function bulkInsertParts(sql: Sql, parts: PartRow[]): Promise<void> {
  const CHUNK = 1000;
  for (let i = 0; i < parts.length; i += CHUNK) {
    const chunk = parts.slice(i, i + CHUNK);
    const rows = chunk.map((p) => ({
      lcsc: p.lcsc,
      mpn: p.mpn,
      manufacturer: p.manufacturer,
      category: p.category,
      subcategory: p.subcategory,
      description: p.description,
      datasheet: p.datasheet,
      package: p.package,
      joints: p.joints,
      stock: p.stock,
      price_raw: p.price_raw,
      img: p.img,
      url: p.url,
      part_type: p.part_type,
      pcba_type: p.pcba_type,
      attributes: p.attributes,
      search_text: p.search_text,
    }));

    await sql`
      INSERT INTO parts ${sql(rows, ...COLUMNS)}
      ON CONFLICT (lcsc) DO UPDATE SET
        mpn = EXCLUDED.mpn,
        manufacturer = EXCLUDED.manufacturer,
        category = EXCLUDED.category,
        subcategory = EXCLUDED.subcategory,
        description = EXCLUDED.description,
        datasheet = EXCLUDED.datasheet,
        package = EXCLUDED.package,
        joints = EXCLUDED.joints,
        stock = EXCLUDED.stock,
        price_raw = EXCLUDED.price_raw,
        img = EXCLUDED.img,
        url = EXCLUDED.url,
        part_type = EXCLUDED.part_type,
        pcba_type = EXCLUDED.pcba_type,
        attributes = EXCLUDED.attributes,
        search_text = EXCLUDED.search_text
    `;

    // Insert numeric attributes
    const lcscs = chunk.map((p) => p.lcsc).filter(Boolean);
    if (lcscs.length > 0) {
      await sql`DELETE FROM part_nums WHERE lcsc IN ${sql(lcscs)}`;
    }
    const numRows: { lcsc: string; unit: string; value: number }[] = [];
    for (const p of chunk) {
      if (!p.lcsc) continue;
      const nums = extractNumericAttrs(p.attributes, p.description);
      for (const { unit, value } of nums) {
        numRows.push({ lcsc: p.lcsc, unit, value });
      }
    }
    if (numRows.length > 0) {
      // Insert in sub-chunks to avoid parameter limits
      const NUM_CHUNK = 5000;
      for (let j = 0; j < numRows.length; j += NUM_CHUNK) {
        const nc = numRows.slice(j, j + NUM_CHUNK);
        await sql`INSERT INTO part_nums ${sql(nc, "lcsc", "unit", "value")}`;
      }
    }
  }
}

/** Update only the stock column for a set of LCSC codes. */
export async function bulkUpdateStock(sql: Sql, stockData: StockData): Promise<void> {
  const entries = Object.entries(stockData);
  const CHUNK = 5000;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    // Use a temp values approach for batch update
    const updates = chunk.map(([lcsc, stock]) => ({
      lcsc: lcsc.toUpperCase().startsWith("C") ? lcsc.toUpperCase() : `C${lcsc}`.toUpperCase(),
      stock,
    }));
    // Update each — postgres library handles batching
    await sql.begin(async (tx) => {
      for (const u of updates) {
        await tx`UPDATE parts SET stock = ${u.stock} WHERE lcsc = ${u.lcsc}`;
      }
    });
  }
}

/** Disable the search_vec trigger for bulk performance. Re-enable with enableSearchTrigger(). */
export async function disableSearchTrigger(sql: Sql): Promise<void> {
  await sql`ALTER TABLE parts DISABLE TRIGGER trg_parts_search_vec`;
}

/** Re-enable search_vec trigger and rebuild all vectors. */
export async function enableSearchTrigger(sql: Sql): Promise<void> {
  await sql`ALTER TABLE parts ENABLE TRIGGER trg_parts_search_vec`;
}

/** Batch-rebuild search_vec for all rows where it's NULL. */
export async function rebuildSearchVectors(sql: Sql): Promise<void> {
  console.log("  Rebuilding search vectors...");
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
  console.log("  Search vectors rebuilt.");
}
