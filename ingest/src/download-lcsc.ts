/**
 * Download phase for LCSC enrichment data.
 * Reads JLCPCB page files to extract unique LCSC codes, then fetches
 * product details from LCSC API and appends to enrichment.ndjson.
 * No database connection needed.
 *
 * Usage: bun run ingest/src/download-lcsc.ts [--fresh]
 */
import { unlinkSync } from "fs";
import { ensureRawDirs, lcscEnrichmentPath } from "./storage.ts";
import {
  readJlcpcbManifest,
  readJlcpcbPageResponses,
  readLcscEnrichment,
  appendLcscEnrichment,
} from "./reader.ts";
import { LCSC_API, LCSC_CONCURRENCY, LCSC_DELAY_MS } from "./jlcpcb-shared.ts";
import type { LcscEnrichmentRecord } from "./types.ts";

let stopping = false;

export async function downloadLcsc(argv?: string[]): Promise<void> {
  const args = argv ?? process.argv.slice(2);
  const isFresh = args.includes("--fresh");

  console.log("jlc-search download: LCSC enrichment");
  ensureRawDirs();

  // Read manifest to get list of queries
  let manifest;
  try {
    manifest = readJlcpcbManifest();
  } catch {
    console.error("No JLCPCB manifest found. Run download-jlcpcb.ts first.");
    process.exit(1);
  }

  // Collect all unique LCSC codes from page files
  console.log("Scanning JLCPCB page files for LCSC codes...");
  const allLcsc = new Set<string>();
  for (const entry of manifest.queries) {
    if (!entry.complete) continue;
    const pages = readJlcpcbPageResponses(entry.slug);
    for (const page of pages) {
      const p = page as { parts?: { componentCode?: string }[] };
      if (p.parts) {
        for (const part of p.parts) {
          if (part.componentCode) {
            allLcsc.add(part.componentCode.toUpperCase());
          }
        }
      }
    }
  }
  console.log(`Found ${allLcsc.size.toLocaleString()} unique LCSC codes`);

  // Load existing enrichment data (skip already-enriched)
  if (isFresh) {
    try { unlinkSync(lcscEnrichmentPath()); } catch {}
  }
  const existing = readLcscEnrichment();
  const toFetch = [...allLcsc].filter(code => !existing.has(code));

  console.log(`Already enriched: ${existing.size.toLocaleString()}, to fetch: ${toFetch.length.toLocaleString()}`);

  if (toFetch.length === 0) {
    console.log("Nothing to fetch.");
    return;
  }

  process.on("SIGINT", () => {
    if (stopping) { console.log("\n  Force quit."); process.exit(1); }
    stopping = true;
    console.log("\n  Stopping after current batch... (Ctrl+C again to force quit)");
  });

  let fetched = 0;
  const total = toFetch.length;

  // Process in groups of LCSC_CONCURRENCY
  for (let i = 0; i < toFetch.length; i += LCSC_CONCURRENCY) {
    if (stopping) break;

    const group = toFetch.slice(i, i + LCSC_CONCURRENCY);
    await Promise.allSettled(
      group.map(async (lcsc) => {
        try {
          const resp = await fetch(`${LCSC_API}?productCode=${lcsc}`, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) {
            appendLcscEnrichment({ lcsc }); // Mark as attempted
            return;
          }
          const data = await resp.json();
          const r = data?.result;

          const record: LcscEnrichmentRecord = { lcsc };
          if (r) {
            if (r.minBuyNumber != null && r.minBuyNumber > 0) {
              record.moq = r.minBuyNumber;
            }
            if (Array.isArray(r.productPriceList) && r.productPriceList.length > 0) {
              const tiers = r.productPriceList
                .sort((a: any, b: any) => a.ladder - b.ladder)
                .map((t: any, idx: number, arr: any[]) => {
                  const end = idx < arr.length - 1 ? arr[idx + 1].ladder - 1 : "";
                  return `${t.ladder}-${end}:${t.usdPrice}`;
                })
                .join(",");
              if (tiers) record.price_raw = tiers;
            }
            if (r.stockNumber != null) {
              record.stock = r.stockNumber;
            }
          }
          appendLcscEnrichment(record);
        } catch {
          appendLcscEnrichment({ lcsc }); // Mark as attempted
        }
      }),
    );

    fetched += group.length;
    if (fetched % 500 === 0 || fetched >= total) {
      const pct = Math.round((fetched / total) * 100);
      console.log(`  [${fetched.toLocaleString()}/${total.toLocaleString()}] ${pct}%`);
    }

    if (i + LCSC_CONCURRENCY < toFetch.length) {
      await Bun.sleep(LCSC_DELAY_MS);
    }
  }

  if (stopping) {
    console.log(`\n=== LCSC download stopped by user ===`);
    console.log(`  Fetched ${fetched.toLocaleString()} of ${total.toLocaleString()}`);
    console.log(`  Resume with: bun run ingest/src/download-lcsc.ts`);
  } else {
    console.log(`\nLCSC enrichment download complete. ${fetched.toLocaleString()} parts enriched.`);
  }
}

// CLI entry point
if (import.meta.main) {
  downloadLcsc().catch((err) => {
    console.error("LCSC download failed:", err);
    process.exit(1);
  });
}
