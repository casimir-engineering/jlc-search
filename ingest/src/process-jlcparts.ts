/**
 * Process phase for jlcparts data.
 * Reads raw files from data/raw/jlcparts/ and populates PostgreSQL.
 */
import postgres from "postgres";
import { applySchema } from "../../backend/src/schema.ts";
import { readLocalIndex, readLocalCategoryData, readLocalStockData } from "./reader.ts";
import { parseComponent } from "./parser.ts";
import {
  bulkInsertParts,
  bulkUpdateStock,
  recoverFromCrash,
  disableSearchTrigger,
  enableSearchTrigger,
  rebuildSearchVectors,
} from "./writer.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jlc:jlc@localhost:5432/jlc";
const CONCURRENCY = parseInt(process.env.INGEST_CONCURRENCY ?? "4");

let stopping = false;

async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0 && !stopping) {
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

export async function processJlcparts(): Promise<void> {
  console.log("jlc-search process: jlcparts");
  console.log(`DB: ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);

  const sql = postgres(DATABASE_URL, { max: 10, onnotice: () => {} });
  await applySchema(sql);
  await recoverFromCrash(sql);

  // Read local index
  const index = readLocalIndex();
  const categories = index.categories;

  // Build work list by comparing against DB ingest_meta
  const workItems: WorkItem[] = [];
  let stockOnlyCount = 0;
  let skipCount = 0;

  for (const [category, subcats] of Object.entries(categories)) {
    for (const [subcategory, meta] of Object.entries(subcats)) {
      const existing = await sql`
        SELECT datahash, stockhash FROM ingest_meta
        WHERE category = ${category} AND subcategory = ${subcategory}
      `;
      const row = existing[0];

      const dataChanged = !row || row.datahash !== meta.datahash;
      const stockChanged = !row || row.stockhash !== meta.stockhash;

      if (!dataChanged && !stockChanged) { skipCount++; continue; }
      if (!dataChanged && stockChanged) stockOnlyCount++;

      workItems.push({
        category, subcategory,
        sourcename: meta.sourcename,
        datahash: meta.datahash,
        stockhash: meta.stockhash,
        dataChanged, stockChanged,
      });
    }
  }

  console.log(
    `Categories: ${workItems.length} to process (${stockOnlyCount} stock-only), ${skipCount} unchanged`,
  );

  if (workItems.length === 0) {
    console.log("Nothing to process.");
    await sql.end();
    return;
  }

  process.on("SIGINT", () => {
    if (stopping) { console.log("\n  Force quit."); process.exit(1); }
    stopping = true;
    console.log("\n  Stopping after in-flight items finish... (Ctrl+C again to force quit)");
  });

  let needsVectorRebuild = false;
  await disableSearchTrigger(sql);

  let processed = 0;
  const total = workItems.length;

  await withConcurrency(workItems, CONCURRENCY, async (item) => {
    try {
      if (item.dataChanged) {
        const data = readLocalCategoryData(item.sourcename);
        const schema = data.schema;
        const parts = (data.components ?? []).map((row) =>
          parseComponent(schema, row, item.category, item.subcategory),
        );
        await bulkInsertParts(sql, parts);
        needsVectorRebuild = true;
      }

      if (item.stockChanged) {
        const stockData = readLocalStockData(item.sourcename);
        await bulkUpdateStock(sql, stockData);
      }

      await sql`
        INSERT INTO ingest_meta (category, subcategory, sourcename, datahash, stockhash, ingested_at)
        VALUES (${item.category}, ${item.subcategory}, ${item.sourcename}, ${item.datahash}, ${item.stockhash}, ${Math.floor(Date.now() / 1000)})
        ON CONFLICT (category, subcategory) DO UPDATE SET
          sourcename = EXCLUDED.sourcename,
          datahash = EXCLUDED.datahash,
          stockhash = EXCLUDED.stockhash,
          ingested_at = EXCLUDED.ingested_at
      `;

      processed++;
      if (processed % 10 === 0 || processed === total) {
        const pct = Math.round((processed / total) * 100);
        console.log(`  [${processed}/${total}] ${pct}% — ${item.category} / ${item.subcategory}`);
      }
    } catch (err) {
      console.error(`  ERROR processing ${item.category}/${item.subcategory}:`, err);
    }
  });

  if (needsVectorRebuild || stopping) {
    await rebuildSearchVectors(sql);
  }
  await enableSearchTrigger(sql);

  const [countRow] = await sql`SELECT COUNT(*) AS cnt FROM parts`;

  if (stopping) {
    console.log(`\n=== Stopped by user ===`);
    console.log(`  Processed ${processed}/${total} subcategories`);
    console.log(`  Total parts in DB: ${countRow?.cnt ?? 0}`);
    console.log(`  Re-run to process remaining subcategories (unchanged ones are skipped).`);
  } else {
    console.log(`\nProcess complete. Total parts in DB: ${countRow?.cnt ?? 0}`);
  }

  await sql.end();
}

// CLI entry point
if (import.meta.main) {
  processJlcparts().catch((err) => {
    console.error("Process failed:", err);
    process.exit(1);
  });
}
