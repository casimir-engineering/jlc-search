/**
 * Download datasheets and extract text in a single pass.
 * Downloads PDFs, extracts text via pdftotext, saves .txt files.
 * PDFs are deleted after extraction unless --keep-pdfs is passed.
 *
 * Usage: bun run ingest/src/download-datasheets.ts [--fresh] [--limit N] [--category "Cat"] [--keep-pdfs]
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from "fs";
import {
  ensureRawDirs,
  datasheetUrlsPath,
  datasheetPdfPath,
  datasheetTextPath,
  datasheetManifestPath,
} from "./storage.ts";
import { extractPdfText, getPdfPageCount } from "./pdf-extract.ts";
import type { DatasheetUrlEntry, DatasheetManifest } from "./types.ts";

const DELAY_MS = 200;
const CONCURRENCY = 3;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

let stopping = false;

function loadUrls(categoryFilter: string | null): DatasheetUrlEntry[] {
  const path = datasheetUrlsPath();
  if (!existsSync(path)) {
    console.error("No urls.ndjson found. Run export-datasheet-urls.ts first.");
    process.exit(1);
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const entries: DatasheetUrlEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as DatasheetUrlEntry;
    if (categoryFilter && entry.category !== categoryFilter) continue;
    entries.push(entry);
  }
  return entries;
}

function loadManifest(): DatasheetManifest {
  try {
    return JSON.parse(readFileSync(datasheetManifestPath(), "utf8"));
  } catch {
    return {
      startedAt: new Date().toISOString(),
      downloaded: 0,
      failed: 0,
      skipped: 0,
      urlMap: {},
      failures: {},
    };
  }
}

function saveManifest(manifest: DatasheetManifest): void {
  writeFileSync(datasheetManifestPath(), JSON.stringify(manifest, null, 2));
}

async function downloadPdf(url: string, destPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (!resp.ok) {
        if (attempt < MAX_RETRIES - 1) {
          await Bun.sleep(2000 * (attempt + 1));
          continue;
        }
        return false;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.length < 100) return false; // too small to be a real PDF
      const tmp = destPath + ".tmp";
      writeFileSync(tmp, buf);
      const { renameSync } = await import("fs");
      renameSync(tmp, destPath);
      return true;
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        await Bun.sleep(2000 * (attempt + 1));
      }
    }
  }
  return false;
}

export async function downloadDatasheets(argv?: string[]): Promise<void> {
  const args = argv ?? process.argv.slice(2);
  const isFresh = args.includes("--fresh");
  const keepPdfs = args.includes("--keep-pdfs");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : Infinity;
  const catIdx = args.indexOf("--category");
  const categoryFilter = catIdx !== -1 ? args[catIdx + 1] : null;

  console.log("jlc-search download: datasheets");
  if (keepPdfs) console.log("  Keeping PDFs after extraction");
  ensureRawDirs();

  const allEntries = loadUrls(categoryFilter);
  console.log(`Loaded ${allEntries.length.toLocaleString()} datasheet URLs`);

  // Filter to entries that need processing
  const entries = allEntries.filter((e) => {
    if (isFresh) return true;
    return !existsSync(datasheetTextPath(e.lcsc));
  });

  const toProcess = Math.min(entries.length, limit);
  const skipped = allEntries.length - entries.length;
  console.log(`To download: ${toProcess.toLocaleString()}, already have text: ${skipped.toLocaleString()}`);

  if (toProcess === 0) {
    console.log("Nothing to download.");
    return;
  }

  let manifest = isFresh ? {
    startedAt: new Date().toISOString(),
    downloaded: 0, failed: 0, skipped: 0,
    urlMap: {}, failures: {},
  } : loadManifest();

  process.on("SIGINT", () => {
    if (stopping) { console.log("\n  Force quit."); process.exit(1); }
    stopping = true;
    console.log("\n  Stopping after current downloads... (Ctrl+C again to force quit)");
  });

  // Build URL dedup map: url → list of lcsc codes
  const urlToLcscs = new Map<string, string[]>();
  for (let i = 0; i < toProcess; i++) {
    const e = entries[i];
    const existing = urlToLcscs.get(e.url);
    if (existing) existing.push(e.lcsc);
    else urlToLcscs.set(e.url, [e.lcsc]);
  }

  const uniqueUrls = [...urlToLcscs.entries()];
  console.log(`Unique URLs: ${uniqueUrls.length.toLocaleString()} (${toProcess - uniqueUrls.length} duplicates)`);

  let processed = 0;
  const total = uniqueUrls.length;

  // Process with concurrency
  const queue = [...uniqueUrls];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0 && !stopping) {
      const [url, lcscs] = queue.shift()!;
      const primaryLcsc = lcscs[0];

      // Skip if already downloaded for this URL
      if (manifest.urlMap[url] && existsSync(datasheetTextPath(manifest.urlMap[url]))) {
        // Copy text to other LCSCs
        const sourceTxt = datasheetTextPath(manifest.urlMap[url]);
        for (const lcsc of lcscs) {
          if (!existsSync(datasheetTextPath(lcsc))) {
            copyFileSync(sourceTxt, datasheetTextPath(lcsc));
          }
        }
        manifest.skipped += lcscs.length;
        processed++;
        continue;
      }

      const pdfPath = datasheetPdfPath(primaryLcsc);
      const txtPath = datasheetTextPath(primaryLcsc);

      // Download PDF
      const ok = await downloadPdf(url, pdfPath);
      if (!ok) {
        for (const lcsc of lcscs) manifest.failures[lcsc] = "download_failed";
        manifest.failed += lcscs.length;
        processed++;
        if (processed % 50 === 0 || processed === total) {
          console.log(`  [${processed}/${total}] ${Math.round((processed / total) * 100)}% — failed: ${primaryLcsc}`);
          saveManifest(manifest);
        }
        await Bun.sleep(DELAY_MS);
        continue;
      }

      // Extract text
      const text = await extractPdfText(pdfPath);
      if (text) {
        writeFileSync(txtPath, text);
      } else {
        // PDF had no extractable text (scanned image, empty, etc.)
        writeFileSync(txtPath, ""); // empty .txt marks as processed
      }

      // Copy text to duplicate LCSCs
      for (let i = 1; i < lcscs.length; i++) {
        copyFileSync(txtPath, datasheetTextPath(lcscs[i]));
      }

      // Delete PDF unless keeping
      if (!keepPdfs) {
        try { unlinkSync(pdfPath); } catch {}
      }

      manifest.urlMap[url] = primaryLcsc;
      manifest.downloaded += lcscs.length;
      processed++;

      if (processed % 50 === 0 || processed === total) {
        const pct = Math.round((processed / total) * 100);
        console.log(`  [${processed}/${total}] ${pct}% — ${primaryLcsc} (${text ? `${(text.length / 1024).toFixed(0)}KB text` : "no text"})`);
        saveManifest(manifest);
      }

      await Bun.sleep(DELAY_MS);
    }
  });

  await Promise.all(workers);

  manifest.completedAt = stopping ? undefined : new Date().toISOString();
  saveManifest(manifest);

  if (stopping) {
    console.log(`\n=== Download stopped by user ===`);
    console.log(`  Downloaded: ${manifest.downloaded}, Failed: ${manifest.failed}, Skipped: ${manifest.skipped}`);
    console.log(`  Resume with: bun run ingest/src/download-datasheets.ts`);
  } else {
    console.log(`\nDatasheet download complete.`);
    console.log(`  Downloaded: ${manifest.downloaded}, Failed: ${manifest.failed}, Skipped: ${manifest.skipped}`);
  }
}

// CLI entry point
if (import.meta.main) {
  downloadDatasheets().catch((err) => {
    console.error("Download failed:", err);
    process.exit(1);
  });
}
