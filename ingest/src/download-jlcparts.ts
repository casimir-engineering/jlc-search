/**
 * Download phase for jlcparts mirror data.
 * Fetches index + category data/stock files to data/raw/jlcparts/.
 * No database connection needed.
 */
import {
  downloadIndexToFile,
  downloadCategoryDataToFile,
  downloadStockDataToFile,
} from "./downloader.ts";
import {
  ensureRawDirs,
  jlcpartsIndexPath,
  jlcpartsDataPath,
  jlcpartsStockPath,
} from "./storage.ts";
import { readLocalIndex, readLocalHashes, writeLocalHashes } from "./reader.ts";
import type { JlcpartsHashes } from "./types.ts";

const JLCPARTS_BASE =
  process.env.JLCPARTS_BASE ?? "https://yaqwsx.github.io/jlcparts";
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

interface DownloadItem {
  category: string;
  subcategory: string;
  sourcename: string;
  datahash: string;
  stockhash: string;
  dataChanged: boolean;
  stockChanged: boolean;
}

export async function downloadJlcparts(): Promise<void> {
  console.log("jlc-search download: jlcparts");
  console.log(`Source: ${JLCPARTS_BASE}`);

  ensureRawDirs();

  // Fetch and save master index
  console.log("Fetching master index...");
  await downloadIndexToFile(JLCPARTS_BASE, jlcpartsIndexPath());
  const index = readLocalIndex();
  const categories = index.categories;

  // Load local hashes
  const hashes = readLocalHashes();

  // Build download list
  const items: DownloadItem[] = [];
  let skipCount = 0;
  let stockOnlyCount = 0;

  for (const [category, subcats] of Object.entries(categories)) {
    for (const [subcategory, meta] of Object.entries(subcats)) {
      const local = hashes[meta.sourcename];
      const dataChanged = !local || local.datahash !== meta.datahash;
      const stockChanged = !local || local.stockhash !== meta.stockhash;

      if (!dataChanged && !stockChanged) { skipCount++; continue; }
      if (!dataChanged && stockChanged) stockOnlyCount++;

      items.push({
        category, subcategory,
        sourcename: meta.sourcename,
        datahash: meta.datahash,
        stockhash: meta.stockhash,
        dataChanged, stockChanged,
      });
    }
  }

  console.log(
    `Categories: ${items.length} to download (${stockOnlyCount} stock-only), ${skipCount} unchanged`,
  );

  if (items.length === 0) {
    console.log("Nothing to download.");
    return;
  }

  process.on("SIGINT", () => {
    if (stopping) { console.log("\n  Force quit."); process.exit(1); }
    stopping = true;
    console.log("\n  Stopping after in-flight downloads... (Ctrl+C again to force quit)");
  });

  let downloaded = 0;
  const total = items.length;

  await withConcurrency(items, CONCURRENCY, async (item) => {
    try {
      if (item.dataChanged) {
        await downloadCategoryDataToFile(
          JLCPARTS_BASE, item.sourcename, jlcpartsDataPath(item.sourcename),
        );
      }
      if (item.stockChanged) {
        await downloadStockDataToFile(
          JLCPARTS_BASE, item.sourcename, jlcpartsStockPath(item.sourcename),
        );
      }

      // Update hashes after successful download
      hashes[item.sourcename] = {
        datahash: item.datahash,
        stockhash: item.stockhash,
        downloadedAt: new Date().toISOString(),
      };
      writeLocalHashes(hashes);

      downloaded++;
      if (downloaded % 10 === 0 || downloaded === total) {
        const pct = Math.round((downloaded / total) * 100);
        console.log(`  [${downloaded}/${total}] ${pct}% — ${item.category} / ${item.subcategory}`);
      }
    } catch (err) {
      console.error(`  ERROR downloading ${item.category}/${item.subcategory}:`, err);
    }
  });

  if (stopping) {
    console.log(`\n=== Download stopped by user ===`);
    console.log(`  Downloaded ${downloaded}/${total} subcategories`);
    console.log(`  Re-run to download remaining (unchanged ones are skipped).`);
  } else {
    console.log(`\nDownload complete. ${downloaded} subcategories downloaded.`);
  }
}

// CLI entry point
if (import.meta.main) {
  downloadJlcparts().catch((err) => {
    console.error("Download failed:", err);
    process.exit(1);
  });
}
