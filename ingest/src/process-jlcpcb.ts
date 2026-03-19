/**
 * Process phase for JLCPCB API data.
 * Reads raw page files from data/raw/jlcpcb-api/ and enrichment from data/raw/lcsc/,
 * transforms them, and populates PostgreSQL.
 *
 * Usage: bun run ingest/src/process-jlcpcb.ts
 */
import postgres from "postgres";
import { applySchema } from "../../backend/src/schema.ts";
import {
  readJlcpcbManifest,
  readJlcpcbPageResponses,
  readLcscEnrichment,
} from "./reader.ts";
import { convertPart, BATCH_SIZE } from "./jlcpcb-shared.ts";
import type { JlcPart } from "./jlcpcb-shared.ts";
import type { PartRow } from "./types.ts";
import {
  bulkInsertParts,
  recoverFromCrash,
  disableSearchTrigger,
  enableSearchTrigger,
  rebuildSearchVectors,
} from "./writer.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jlc:jlc@localhost:5432/jlc";

let stopping = false;

export async function processJlcpcb(): Promise<void> {
  console.log("jlc-search process: JLCPCB API");
  console.log(`DB: ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);

  const sql = postgres(DATABASE_URL, { max: 10, onnotice: () => {} });
  await applySchema(sql);
  await recoverFromCrash(sql);

  const [existing] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const existingCount = Number(existing?.cnt ?? 0);
  console.log(`Existing parts in DB: ${existingCount.toLocaleString()}`);

  // Read manifest
  let manifest;
  try {
    manifest = readJlcpcbManifest();
  } catch {
    console.error("No JLCPCB manifest found. Run download-jlcpcb.ts first.");
    await sql.end();
    process.exit(1);
  }

  // Load LCSC enrichment
  console.log("Loading LCSC enrichment data...");
  const enrichment = readLcscEnrichment();
  console.log(`  ${enrichment.size.toLocaleString()} enrichment records loaded`);

  const completedQueries = manifest.queries.filter(q => q.complete);
  console.log(`Processing ${completedQueries.length} completed queries...`);

  if (completedQueries.length === 0) {
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

  let totalProcessed = 0;
  let totalNew = 0;

  for (const entry of completedQueries) {
    if (stopping) break;

    const pages = readJlcpcbPageResponses(entry.slug);
    if (pages.length === 0) continue;

    // Extract all parts from pages
    const allParts: PartRow[] = [];
    for (const page of pages) {
      const p = page as { parts?: JlcPart[] };
      if (p.parts) {
        for (const part of p.parts) {
          const row = convertPart(part);

          // Apply LCSC enrichment
          const enriched = enrichment.get(row.lcsc);
          if (enriched) {
            if (enriched.moq != null) row.moq = enriched.moq;
            if (enriched.price_raw) row.price_raw = enriched.price_raw;
            if (enriched.stock != null) row.stock = enriched.stock;
          }

          allParts.push(row);
        }
      }
    }

    // Insert in batches
    for (let i = 0; i < allParts.length; i += BATCH_SIZE) {
      if (stopping) break;
      const batch = allParts.slice(i, i + BATCH_SIZE);
      const stats = await bulkInsertParts(sql, batch);
      totalNew += stats.inserted;
    }

    totalProcessed += allParts.length;
    console.log(`  ${entry.label}: ${allParts.length.toLocaleString()} parts`);
  }

  // Rebuild search vectors and re-enable trigger
  await rebuildSearchVectors(sql);
  await enableSearchTrigger(sql);

  const [finalRow] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const finalCount = Number(finalRow?.cnt ?? 0);

  if (stopping) {
    console.log("\n=== Stopped by user ===");
  }

  console.log("\n=== JLCPCB Processing Complete ===");
  console.log(`  Parts processed:    ${totalProcessed.toLocaleString()}`);
  console.log(`  New parts inserted: ${totalNew.toLocaleString()}`);
  console.log(`  Parts before:       ${existingCount.toLocaleString()}`);
  console.log(`  Parts after:        ${finalCount.toLocaleString()}`);

  await sql.end();
}

// CLI entry point
if (import.meta.main) {
  processJlcpcb().catch((err) => {
    console.error("Process failed:", err);
    process.exit(1);
  });
}
