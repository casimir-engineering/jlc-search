/**
 * Process phase for datasheet text.
 * Reads .txt files from data/raw/datasheets/, runs component-aware extraction,
 * and writes extracted properties + keywords to the database.
 *
 * Usage: bun run ingest/src/process-datasheets.ts [--fresh]
 */
import postgres from "postgres";
import { readFileSync, readdirSync, existsSync } from "fs";
import { applySchema } from "../../backend/src/schema.ts";
import { datasheetTextPath, datasheetUrlsPath, DATASHEETS_DIR } from "./storage.ts";
import { extractComponentProperties } from "./component-text.ts";
import {
  appendSearchKeywords,
  insertDatasheetNums,
  upsertDatasheetMeta,
  disableSearchTrigger,
  enableSearchTrigger,
  rebuildSearchVectors,
} from "./writer.ts";
import type { DatasheetUrlEntry } from "./types.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jlc:jlc@localhost:5432/jlc";
const BATCH_SIZE = 100;

let stopping = false;

export async function processDatasheets(argv?: string[]): Promise<void> {
  const args = argv ?? process.argv.slice(2);
  const isFresh = args.includes("--fresh");

  console.log("jlc-search process: datasheets");
  console.log(`DB: ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);

  const sql = postgres(DATABASE_URL, { max: 10, onnotice: () => {} });
  await applySchema(sql);

  // Load category lookup from urls.ndjson
  const categoryMap = new Map<string, { category: string; subcategory: string }>();
  if (existsSync(datasheetUrlsPath())) {
    const lines = readFileSync(datasheetUrlsPath(), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as DatasheetUrlEntry;
      categoryMap.set(entry.lcsc, { category: entry.category, subcategory: entry.subcategory });
    }
  }

  // Find .txt files that need processing
  const allTxtFiles = readdirSync(DATASHEETS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(".txt", ""));

  let toProcess: string[];
  if (isFresh) {
    toProcess = allTxtFiles;
  } else {
    // Check which ones are already in datasheet_meta
    const existing = await sql`SELECT lcsc FROM datasheet_meta`;
    const existingSet = new Set(existing.map((r) => r.lcsc));
    toProcess = allTxtFiles.filter((lcsc) => !existingSet.has(lcsc));
  }

  console.log(`Text files: ${allTxtFiles.length.toLocaleString()}, to process: ${toProcess.length.toLocaleString()}`);

  if (toProcess.length === 0) {
    console.log("Nothing to process.");
    await sql.end();
    return;
  }

  process.on("SIGINT", () => {
    if (stopping) { console.log("\n  Force quit."); process.exit(1); }
    stopping = true;
    console.log("\n  Stopping after current batch... (Ctrl+C again to force quit)");
  });

  await disableSearchTrigger(sql);

  let processed = 0;
  const total = toProcess.length;

  // Process in batches
  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    if (stopping) break;

    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const keywordUpdates: { lcsc: string; keywords: string }[] = [];
    const numRows: { lcsc: string; unit: string; value: number }[] = [];

    for (const lcsc of batch) {
      const txtPath = datasheetTextPath(lcsc);
      const text = readFileSync(txtPath, "utf8");

      // Look up category
      const catInfo = categoryMap.get(lcsc);
      const category = catInfo?.category ?? "";
      const subcategory = catInfo?.subcategory ?? "";

      // Run extraction
      const result = extractComponentProperties(text, category, subcategory, "datasheet");

      // Collect keyword updates
      if (result.keywords.length > 0) {
        keywordUpdates.push({ lcsc, keywords: result.keywords.join(" ") });
      }

      // Collect numeric values
      for (const prop of result.properties) {
        numRows.push({ lcsc, unit: prop.unit, value: prop.value });
      }

      // Record metadata
      await upsertDatasheetMeta(sql, {
        lcsc,
        extracted_at: Math.floor(Date.now() / 1000),
        page_count: 0, // page count not available from .txt file
        char_count: text.length,
        props_found: result.properties.length,
      });
    }

    // Batch write keywords
    if (keywordUpdates.length > 0) {
      await appendSearchKeywords(sql, keywordUpdates);
    }

    // Batch write numeric values
    if (numRows.length > 0) {
      await insertDatasheetNums(sql, numRows);
    }

    processed += batch.length;
    const pct = Math.round((processed / total) * 100);
    console.log(`  [${processed}/${total}] ${pct}% — ${keywordUpdates.length} keyword updates, ${numRows.length} numeric values`);
  }

  // Rebuild search vectors for all parts we touched
  console.log("Rebuilding search vectors...");
  await rebuildSearchVectors(sql);
  await enableSearchTrigger(sql);

  const [metaCount] = await sql`SELECT COUNT(*) AS cnt FROM datasheet_meta`;
  console.log(`\nProcess complete. ${processed} datasheets processed, ${metaCount?.cnt ?? 0} total in datasheet_meta.`);

  await sql.end();
}

// CLI entry point
if (import.meta.main) {
  processDatasheets().catch((err) => {
    console.error("Process failed:", err);
    process.exit(1);
  });
}
