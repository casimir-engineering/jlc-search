import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { mkdirSync } from "fs";
import { SCHEMA_SQL } from "../../backend/src/schema.ts";
import { fetchIndex, fetchCategoryData, fetchStockData } from "./downloader.ts";
import { parseComponent } from "./parser.ts";
import {
  bulkInsertParts,
  bulkUpdateStock,
  dropFtsTriggers,
  rebuildFts,
  recreateFtsTriggers,
} from "./writer.ts";

const JLCPARTS_BASE =
  process.env.JLCPARTS_BASE ?? "https://yaqwsx.github.io/jlcparts";
const DB_PATH =
  process.env.DB_PATH ?? join(import.meta.dir, "../../data/parts.db");
const CONCURRENCY = parseInt(process.env.INGEST_CONCURRENCY ?? "4");

// Ensure data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

interface WorkItem {
  category: string;
  subcategory: string;
  sourcename: string;
  datahash: string;
  stockhash: string;
  dataChanged: boolean;
  stockChanged: boolean;
}

async function main() {
  console.log(`jst-search ingest`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Source: ${JLCPARTS_BASE}`);

  const db = new Database(DB_PATH, { create: true });
  db.exec(SCHEMA_SQL);

  // Fetch master index
  const index = await fetchIndex(JLCPARTS_BASE);
  const categories = index.categories;

  // Build work list: check which categories have changed
  const workItems: WorkItem[] = [];
  let stockOnlyCount = 0;
  let skipCount = 0;

  for (const [category, subcats] of Object.entries(categories)) {
    for (const [subcategory, meta] of Object.entries(subcats)) {
      const existing = db.query<
        { datahash: string; stockhash: string },
        [string, string]
      >(
        "SELECT datahash, stockhash FROM ingest_meta WHERE category = ? AND subcategory = ?"
      ).get(category, subcategory);

      const dataChanged = !existing || existing.datahash !== meta.datahash;
      const stockChanged = !existing || existing.stockhash !== meta.stockhash;

      if (!dataChanged && !stockChanged) {
        skipCount++;
        continue;
      }
      if (!dataChanged && stockChanged) stockOnlyCount++;

      workItems.push({
        category,
        subcategory,
        sourcename: meta.sourcename,
        datahash: meta.datahash,
        stockhash: meta.stockhash,
        dataChanged,
        stockChanged,
      });
    }
  }

  console.log(
    `Categories: ${workItems.length} to update (${stockOnlyCount} stock-only), ${skipCount} unchanged`
  );

  if (workItems.length === 0) {
    console.log("Nothing to do.");
    db.close();
    return;
  }

  // Drop FTS triggers for bulk performance
  dropFtsTriggers(db);

  let processed = 0;
  const total = workItems.length;
  let ftsRebuildNeeded = false;

  await withConcurrency(workItems, CONCURRENCY, async (item) => {
    try {
      if (item.dataChanged) {
        const data = await fetchCategoryData(JLCPARTS_BASE, item.sourcename);
        const schema = data.schema;
        const parts = (data.components ?? []).map((row) =>
          parseComponent(schema, row, item.category, item.subcategory)
        );
        bulkInsertParts(db, parts);
        ftsRebuildNeeded = true;
      }

      if (item.stockChanged) {
        const stockData = await fetchStockData(JLCPARTS_BASE, item.sourcename);
        bulkUpdateStock(db, stockData);
      }

      // Update ingest_meta
      db.run(
        `INSERT OR REPLACE INTO ingest_meta
          (category, subcategory, sourcename, datahash, stockhash, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          item.category,
          item.subcategory,
          item.sourcename,
          item.datahash,
          item.stockhash,
          Math.floor(Date.now() / 1000),
        ]
      );

      processed++;
      if (processed % 10 === 0 || processed === total) {
        const pct = Math.round((processed / total) * 100);
        console.log(`  [${processed}/${total}] ${pct}% — ${item.category} / ${item.subcategory}`);
      }
    } catch (err) {
      console.error(`  ERROR processing ${item.category}/${item.subcategory}:`, err);
    }
  });

  // Rebuild FTS index and restore triggers
  if (ftsRebuildNeeded) {
    recreateFtsTriggers(db);
    rebuildFts(db);
  } else {
    recreateFtsTriggers(db);
  }

  const countRow = db.query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM parts").get();
  console.log(`\nIngest complete. Total parts in DB: ${countRow?.cnt ?? 0}`);

  db.close();
}

main().catch((err) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
