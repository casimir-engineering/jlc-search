import type postgres from "postgres";
import type { PartRow, StockData } from "./types.ts";
import { extractNumericAttrs } from "./attrs.ts";

type Sql = ReturnType<typeof postgres>;

const COLUMNS = [
  "lcsc", "mpn", "manufacturer", "category", "subcategory", "description",
  "datasheet", "package", "joints", "moq", "stock", "price_raw", "img", "url",
  "part_type", "pcba_type", "attributes", "search_text",
] as const;

/** Deduplicate parts by LCSC within a batch — keep last occurrence. */
function dedup(parts: PartRow[]): PartRow[] {
  const map = new Map<string, PartRow>();
  for (const p of parts) {
    if (p.lcsc) map.set(p.lcsc, p);
  }
  return [...map.values()];
}

export interface UpsertStats { inserted: number; updated: number }

/** Bulk upsert parts in chunks. Returns count of actual inserts vs updates. */
export async function bulkInsertParts(sql: Sql, parts: PartRow[]): Promise<UpsertStats> {
  const stats: UpsertStats = { inserted: 0, updated: 0 };
  const CHUNK = 1000;

  for (let i = 0; i < parts.length; i += CHUNK) {
    const chunk = dedup(parts.slice(i, i + CHUNK));
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
      moq: p.moq,
      stock: p.stock,
      price_raw: p.price_raw,
      img: p.img,
      url: p.url,
      part_type: p.part_type,
      pcba_type: p.pcba_type,
      attributes: p.attributes,
      search_text: p.search_text,
    }));

    // xmax = 0 means the row was freshly inserted (no prior version)
    const result = await sql`
      INSERT INTO parts ${sql(rows, ...COLUMNS)}
      ON CONFLICT (lcsc) DO UPDATE SET
        mpn = EXCLUDED.mpn,
        manufacturer = EXCLUDED.manufacturer,
        category = EXCLUDED.category,
        subcategory = EXCLUDED.subcategory,
        description = EXCLUDED.description,
        datasheet = EXCLUDED.datasheet,
        package = EXCLUDED.package,
        joints = COALESCE(EXCLUDED.joints, parts.joints),
        moq = COALESCE(EXCLUDED.moq, parts.moq),
        stock = EXCLUDED.stock,
        price_raw = EXCLUDED.price_raw,
        img = EXCLUDED.img,
        url = EXCLUDED.url,
        part_type = EXCLUDED.part_type,
        pcba_type = EXCLUDED.pcba_type,
        attributes = EXCLUDED.attributes,
        search_text = EXCLUDED.search_text
      RETURNING (xmax = 0) AS is_insert
    `;
    for (const r of result) {
      if (r.is_insert) stats.inserted++;
      else stats.updated++;
    }

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
      const NUM_CHUNK = 5000;
      for (let j = 0; j < numRows.length; j += NUM_CHUNK) {
        const nc = numRows.slice(j, j + NUM_CHUNK);
        await sql`INSERT INTO part_nums ${sql(nc, "lcsc", "unit", "value")}`;
      }
    }
  }
  return stats;
}

/** Batch-update stock using unnest for O(1)-query-per-chunk performance. */
export async function bulkUpdateStock(sql: Sql, stockData: StockData): Promise<void> {
  const entries = Object.entries(stockData);
  const CHUNK = 10000;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const lcscs: string[] = [];
    const stocks: number[] = [];
    for (const [lcsc, stock] of chunk) {
      lcscs.push(lcsc.toUpperCase().startsWith("C") ? lcsc.toUpperCase() : `C${lcsc}`.toUpperCase());
      stocks.push(stock);
    }
    await sql`
      UPDATE parts SET stock = v.stock
      FROM unnest(${lcscs}::text[], ${stocks}::int[]) AS v(lcsc, stock)
      WHERE parts.lcsc = v.lcsc
    `;
  }
}

/** Recover from a prior crash: rebuild any NULL search vectors and re-enable the trigger. */
export async function recoverFromCrash(sql: Sql): Promise<void> {
  const [{ cnt }] = await sql`SELECT COUNT(*) AS cnt FROM parts WHERE search_vec IS NULL`;
  if (Number(cnt) > 0) {
    console.log(`  Recovering from prior crash: ${Number(cnt).toLocaleString()} parts missing search vectors...`);
    await rebuildSearchVectors(sql);
    await enableSearchTrigger(sql);
    console.log("  Recovery complete.");
  }
}

/** Disable the search_vec trigger for bulk performance. Re-enable with enableSearchTrigger(). */
export async function disableSearchTrigger(sql: Sql): Promise<void> {
  await sql`ALTER TABLE parts DISABLE TRIGGER trg_parts_search_vec`;
}

/** Re-enable search_vec trigger. */
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
