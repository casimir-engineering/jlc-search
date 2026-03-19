/**
 * Download phase for JLCPCB API data.
 * Fetches pages from the JLCPCB API and saves raw JSON responses to data/raw/jlcpcb-api/.
 * Supports resume: reads manifest to skip completed queries, resumes from last page.
 * No database connection needed.
 *
 * Usage: bun run ingest/src/download-jlcpcb.ts [--fresh] [--categories "Cat1|Cat2"] [--instock-only]
 */
import { mkdirSync, writeFileSync, existsSync } from "fs";
import {
  ensureRawDirs,
  slugify,
  jlcpcbPageDir,
  jlcpcbPagePath,
} from "./storage.ts";
import {
  readJlcpcbManifest,
  writeJlcpcbManifest,
  countJlcpcbPages,
} from "./reader.ts";
import {
  fetchPage,
  buildWorkQueue,
  buildQueryKey,
  parseCategoryFilter,
  AdaptivePacer,
  DELAY_MS,
  MAX_PAGES,
  PAGE_SIZE,
  MAX_FETCHABLE,
} from "./jlcpcb-shared.ts";
import type { JlcpcbRunManifest, JlcpcbQueryEntry } from "./types.ts";

let stopping = false;

export async function downloadJlcpcb(argv?: string[]): Promise<void> {
  const args = argv ?? process.argv.slice(2);
  const isFresh = args.includes("--fresh");
  const instockOnly = args.includes("--instock-only");
  const categoryFilter = parseCategoryFilter(args);

  console.log("jlc-search download: JLCPCB API");
  ensureRawDirs();

  // Load or create manifest
  let manifest: JlcpcbRunManifest;
  if (isFresh || !existsSync("data/raw/jlcpcb-api/manifest.json")) {
    manifest = { startedAt: new Date().toISOString(), queries: [] };
  } else {
    try {
      manifest = readJlcpcbManifest();
    } catch {
      manifest = { startedAt: new Date().toISOString(), queries: [] };
    }
  }

  process.on("SIGINT", () => {
    if (stopping) { console.log("\n  Force quit."); process.exit(1); }
    stopping = true;
    console.log("\n  Stopping after current page... (Ctrl+C again to force quit)");
  });

  // Build work queue (probes API for totals)
  console.log("\nBuilding work queue (probing API for category sizes)...\n");
  const allQueries = await buildWorkQueue({ categoryFilter, instockOnly });

  // Merge with existing manifest entries
  const existingByKey = new Map(manifest.queries.map(q => [q.key, q]));

  for (const query of allQueries) {
    if (!existingByKey.has(query.key)) {
      const slug = slugify(query.key);
      const entry: JlcpcbQueryEntry = {
        key: query.key,
        slug,
        label: query.label,
        params: query.params,
        totalParts: 0,
        pagesDownloaded: 0,
        complete: false,
      };
      manifest.queries.push(entry);
      existingByKey.set(query.key, entry);
    }
  }
  writeJlcpcbManifest(manifest);

  // Process each query
  const pendingQueries = manifest.queries.filter(q => !q.complete);
  const doneCount = manifest.queries.length - pendingQueries.length;
  console.log(`\nWork queue: ${manifest.queries.length} queries — ${doneCount} done, ${pendingQueries.length} pending`);

  let totalFetched = 0;
  const pacer = new AdaptivePacer(200, 50, 5000);

  for (const entry of pendingQueries) {
    if (stopping) break;

    // Ensure page directory exists
    const pageDir = jlcpcbPageDir(entry.slug);
    mkdirSync(pageDir, { recursive: true });

    // Resume: count existing pages
    const existingPages = countJlcpcbPages(entry.slug);
    const startPage = existingPages > 0 ? existingPages + 1 : 1;

    if (startPage > 1) {
      console.log(`\n[${entry.label}] Resuming from page ${startPage}...`);
    }

    // Fetch first page (or resume page) to get total
    const firstResult = await fetchPage(entry.params, startPage, pacer);
    if (!firstResult || firstResult.parts.length === 0) {
      if (startPage === 1) {
        console.log(`[${entry.label}] No results, skipping`);
      }
      entry.complete = true;
      entry.pagesDownloaded = existingPages;
      writeJlcpcbManifest(manifest);
      continue;
    }

    const totalParts = firstResult.total;
    const totalPages = Math.min(Math.ceil(totalParts / PAGE_SIZE), MAX_PAGES);
    entry.totalParts = totalParts;

    const cappedParts = Math.min(totalParts, MAX_FETCHABLE);
    const cappedNote = totalParts > MAX_FETCHABLE
      ? ` (capped from ${totalParts.toLocaleString()})`
      : "";
    console.log(`\n[${entry.label}] ${cappedParts.toLocaleString()}${cappedNote} parts, ${totalPages} pages`);

    // Write first page response
    writeFileSync(
      jlcpcbPagePath(entry.slug, startPage),
      JSON.stringify({ parts: firstResult.parts, total: firstResult.total }),
    );
    totalFetched += firstResult.parts.length;
    entry.pagesDownloaded = startPage;

    // Fetch remaining pages
    for (let page = startPage + 1; page <= totalPages; page++) {
      if (stopping) break;

      await pacer.wait();
      const result = await fetchPage(entry.params, page, pacer);
      if (!result || result.parts.length === 0) break;

      writeFileSync(
        jlcpcbPagePath(entry.slug, page),
        JSON.stringify({ parts: result.parts, total: result.total }),
      );
      totalFetched += result.parts.length;
      entry.pagesDownloaded = page;

      if (page % 50 === 0) {
        const pct = ((page / totalPages) * 100).toFixed(0);
        console.log(`  Page ${page}/${totalPages} (${pct}%) delay=${pacer.currentDelay}ms`);
        writeJlcpcbManifest(manifest);
      }
    }

    if (!stopping) {
      entry.complete = true;
      writeJlcpcbManifest(manifest);
      console.log(`  Done: ${entry.pagesDownloaded} pages from ${entry.label}`);
    } else {
      writeJlcpcbManifest(manifest);
    }
  }

  if (stopping) {
    console.log("\n=== Download stopped by user ===");
    console.log(`  Parts fetched this run: ${totalFetched.toLocaleString()}`);
    console.log(`  Queries completed: ${manifest.queries.filter(q => q.complete).length}/${manifest.queries.length}`);
    console.log(`  Resume with: bun run ingest/src/download-jlcpcb.ts`);
  } else {
    manifest.completedAt = new Date().toISOString();
    writeJlcpcbManifest(manifest);
    console.log(`\nJLCPCB download complete. ${totalFetched.toLocaleString()} parts fetched.`);
  }
}

// CLI entry point
if (import.meta.main) {
  downloadJlcpcb().catch((err) => {
    console.error("Download failed:", err);
    process.exit(1);
  });
}
