/**
 * Download datasheets via JLCPCB part pages + file API.
 * Workaround for LCSC CDN blocking: fetches the fileSystemAccessId
 * from each part's JLCPCB page, then downloads via the JLCPCB file API.
 *
 * Usage: bun run ingest/src/download-datasheets-jlcpcb.ts [--category "Cat"] [--limit N] [--keep-pdfs]
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from "fs";
import {
  ensureRawDirs,
  datasheetUrlsPath,
  datasheetPdfPath,
  datasheetTextPath,
  DATASHEETS_DIR,
} from "./storage.ts";
import { extractPdfText } from "./pdf-extract.ts";
import type { DatasheetUrlEntry } from "./types.ts";

const CONCURRENCY = 5;
const RESOLVE_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DELAY_MS = 100;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
    // Only include LCSC-hosted URLs (the ones that are blocked)
    if (!entry.url.includes("lcsc.com")) continue;
    entries.push(entry);
  }
  return entries;
}

async function resolveFileId(lcsc: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://jlcpcb.com/partdetail/${lcsc}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const match = html.match(/downloadByFileSystemAccessId\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function downloadPdf(fileId: string, destPath: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://jlcpcb.com/api/file/downloadByFileSystemAccessId/${fileId}`,
      {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: "follow",
      }
    );
    if (!resp.ok) return false;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length < 100) return false;
    const tmp = destPath + ".tmp";
    writeFileSync(tmp, buf);
    const { renameSync } = await import("fs");
    renameSync(tmp, destPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const keepPdfs = args.includes("--keep-pdfs");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : Infinity;
  const catIdx = args.indexOf("--category");
  const categoryFilter = catIdx !== -1 ? args[catIdx + 1] : null;

  console.log("jlc-search download: datasheets via JLCPCB file API");
  if (keepPdfs) console.log("  Keeping PDFs after extraction");
  ensureRawDirs();

  const allEntries = loadUrls(categoryFilter);
  console.log(`Loaded ${allEntries.length.toLocaleString()} LCSC-hosted datasheet URLs`);

  // Filter to entries that need processing
  const entries = allEntries.filter((e) => !existsSync(datasheetTextPath(e.lcsc)));
  const toProcess = Math.min(entries.length, limit);
  console.log(`To download: ${toProcess.toLocaleString()}, already have text: ${allEntries.length - entries.length}`);

  if (toProcess === 0) {
    console.log("Nothing to download.");
    return;
  }

  // Dedup by URL
  const urlToLcscs = new Map<string, string[]>();
  for (let i = 0; i < toProcess; i++) {
    const e = entries[i];
    const existing = urlToLcscs.get(e.url);
    if (existing) existing.push(e.lcsc);
    else urlToLcscs.set(e.url, [e.lcsc]);
  }

  const uniqueEntries = [...urlToLcscs.entries()];
  console.log(`Unique URLs: ${uniqueEntries.length} (${toProcess - uniqueEntries.length} duplicates)`);

  process.on("SIGINT", () => {
    if (stopping) { console.log("\n  Force quit."); process.exit(1); }
    stopping = true;
    console.log("\n  Stopping after current downloads...");
  });

  let processed = 0;
  let downloaded = 0;
  let failed = 0;
  const total = uniqueEntries.length;

  const queue = [...uniqueEntries];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0 && !stopping) {
      const [_url, lcscs] = queue.shift()!;
      const primaryLcsc = lcscs[0];
      const pdfPath = datasheetPdfPath(primaryLcsc);
      const txtPath = datasheetTextPath(primaryLcsc);

      // Step 1: Resolve fileSystemAccessId from JLCPCB part page
      const fileId = await resolveFileId(primaryLcsc);
      if (!fileId) {
        failed += lcscs.length;
        processed++;
        if (processed % 50 === 0 || processed === total) {
          console.log(`  [${processed}/${total}] ${Math.round((processed / total) * 100)}% — no fileId: ${primaryLcsc} (${downloaded} ok, ${failed} fail)`);
        }
        await Bun.sleep(DELAY_MS);
        continue;
      }

      // Step 2: Download PDF via file API
      const ok = await downloadPdf(fileId, pdfPath);
      if (!ok) {
        failed += lcscs.length;
        processed++;
        if (processed % 50 === 0 || processed === total) {
          console.log(`  [${processed}/${total}] ${Math.round((processed / total) * 100)}% — download failed: ${primaryLcsc} (${downloaded} ok, ${failed} fail)`);
        }
        await Bun.sleep(DELAY_MS);
        continue;
      }

      // Step 3: Extract text
      const text = await extractPdfText(pdfPath);
      writeFileSync(txtPath, text ?? "");

      // Copy to duplicate LCSCs
      for (let i = 1; i < lcscs.length; i++) {
        copyFileSync(txtPath, datasheetTextPath(lcscs[i]));
      }

      // Delete PDF unless keeping
      if (!keepPdfs) {
        try { unlinkSync(pdfPath); } catch {}
      }

      downloaded += lcscs.length;
      processed++;

      if (processed % 50 === 0 || processed === total) {
        const pct = Math.round((processed / total) * 100);
        console.log(`  [${processed}/${total}] ${pct}% — ${primaryLcsc} (${text ? `${(text.length / 1024).toFixed(0)}KB` : "no text"}) (${downloaded} ok, ${failed} fail)`);
      }

      await Bun.sleep(DELAY_MS);
    }
  });

  await Promise.all(workers);

  console.log(`\nDownload complete.`);
  console.log(`  Downloaded: ${downloaded}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error("Download failed:", err);
  process.exit(1);
});
