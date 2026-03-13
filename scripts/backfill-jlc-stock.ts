/**
 * Bulk backfill jlc_stock column from JLCPCB API.
 *
 * Iterates through all JLCPCB categories, pages through results,
 * and updates the jlc_stock column in the parts table.
 *
 * Usage: bun run scripts/backfill-jlc-stock.ts [--fresh]
 *
 * --fresh  Discard progress and start over.
 *
 * Auto-resumes from data/jlcpcb-stock-progress.json if interrupted.
 * Ctrl+C stops gracefully: flushes pending updates and saves progress.
 */
import postgres from "postgres";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";

const DATABASE_URL = "postgres://jlc:jlc@localhost:5432/jlc";
const API_URL =
  "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList";
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_FETCHABLE = MAX_PAGES * PAGE_SIZE; // 100,000
const DELAY_MS = 100; // delay between batches
const BATCH_CONCURRENCY = 5; // parallel page fetches per batch
const FLUSH_THRESHOLD = 5_000;
const PROGRESS_FILE = "data/jlcpcb-stock-progress.json";

const CATEGORIES = [
  "Resistors", "Capacitors", "Connectors",
  "Crystals, Oscillators, Resonators", "Others",
  "Inductors, Coils, Chokes", "Circuit Protection",
  "Switches", "Diodes", "Optoelectronics",
  "Embedded Processors & Controllers", "Power Modules",
  "Memory", "Logic", "Filters", "Interface", "Sensors",
  "Relays", "Motor Driver ICs", "Audio Products / Vibration Motors",
  "LED Drivers", "Hardware Fasteners", "IoT/Communication Modules",
  "Displays", "Development Boards & Tools",
  "Amplifiers", "Data Converters", "Clock and Timing",
  "Power Management", "RF And Wireless", "Isolators",
  "Battery Products", "Fuses", "Wires And Cables",
  "Buzzers & Speakers & Microphones", "Industrial Control Electrical",
  "Transistors", "Consumables",
];

// ── Types ──

interface StockEntry {
  lcsc: string;
  stockCount: number;
}

interface Progress {
  completedCategories: string[];
  currentCategory: string | null;
  currentPage: number;
  totalUpdated: number;
}

interface ApiResponse {
  code: number;
  data?: {
    componentPageInfo?: {
      total: number;
      list: Array<{
        componentCode: string;
        stockCount: number;
        firstSortName: string;  // subcategory in response
        secondSortName: string; // main category in response
      }> | null;
    };
  };
}

// ── Progress tracking ──

function loadProgress(): Progress {
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
    if (!Array.isArray(raw.completedCategories) || typeof raw.totalUpdated !== "number") {
      throw new Error("invalid shape");
    }
    return raw as Progress;
  } catch {
    return {
      completedCategories: [],
      currentCategory: null,
      currentPage: 1,
      totalUpdated: 0,
    };
  }
}

function saveProgress(progress: Progress): void {
  mkdirSync("data", { recursive: true });
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── API fetch ──

async function fetchPage(
  params: Record<string, unknown>,
  page: number,
): Promise<{ parts: Array<{ componentCode: string; stockCount: number; firstSortName: string; secondSortName: string }>; total: number } | null> {
  const body = {
    keyword: "",
    pageSize: PAGE_SIZE,
    currentPage: page,
    ...params,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        console.error(`  HTTP ${resp.status} for page ${page}, attempt ${attempt + 1}/3, retrying...`);
        await Bun.sleep(2000 * (attempt + 1));
        continue;
      }

      const data = (await resp.json()) as ApiResponse;

      if (data.code !== 200 || !data.data?.componentPageInfo?.list) {
        return null;
      }

      return {
        parts: data.data.componentPageInfo.list,
        total: data.data.componentPageInfo.total,
      };
    } catch (err) {
      console.error(`  Fetch error for page ${page}, attempt ${attempt + 1}/3: ${err}`);
      await Bun.sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// ── Subcategory discovery ──

async function discoverSubcategories(category: string): Promise<string[]> {
  const seen = new Set<string>();
  // Sample several pages spread across the result set to find subcategories
  // Note: in the API response, firstSortName is the subcategory, secondSortName is the main category
  for (const page of [1, 200, 400, 600, 800, 1000]) {
    const result = await fetchPage({ firstSortName: category }, page);
    if (result) {
      for (const part of result.parts) {
        if (part.firstSortName) seen.add(part.firstSortName);
      }
    }
    await Bun.sleep(DELAY_MS);
  }
  return [...seen];
}

// ── DB update ──

async function flushUpdates(
  sql: ReturnType<typeof postgres>,
  buffer: StockEntry[],
): Promise<number> {
  if (buffer.length === 0) return 0;

  const codes = buffer.map((e) => e.lcsc);
  const stocks = buffer.map((e) => e.stockCount);

  const result = await sql`
    UPDATE parts SET jlc_stock = v.jlc_stock
    FROM (SELECT unnest(${codes}::text[]) AS lcsc, unnest(${stocks}::int[]) AS jlc_stock) AS v
    WHERE parts.lcsc = v.lcsc
  `;

  return result.count;
}

// ── Process a single query (category or subcategory) ──

interface QueryResult {
  fetched: number;
  updated: number;
  stopped: boolean;
}

async function processQuery(
  sql: ReturnType<typeof postgres>,
  params: Record<string, unknown>,
  label: string,
  startPage: number,
  progress: Progress,
  isStopping: () => boolean,
): Promise<QueryResult> {
  // Fetch page 1 (or resume page) to get total
  const firstResult = await fetchPage(params, startPage);
  if (!firstResult || firstResult.parts.length === 0) {
    console.log(`  [${label}] No results, skipping`);
    return { fetched: 0, updated: 0, stopped: false };
  }

  const totalParts = firstResult.total;
  const totalPages = Math.min(Math.ceil(totalParts / PAGE_SIZE), MAX_PAGES);
  const cappedNote = totalParts > MAX_FETCHABLE
    ? ` (capped from ${totalParts.toLocaleString()})`
    : "";
  console.log(`  [${label}] ${Math.min(totalParts, MAX_FETCHABLE).toLocaleString()}${cappedNote} parts, ${totalPages} pages`);

  let buffer: StockEntry[] = [];
  let totalFetched = 0;
  let totalUpdatedThisQuery = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    const count = await flushUpdates(sql, buffer);
    totalUpdatedThisQuery += count;
    progress.totalUpdated += count;
    buffer = [];
    saveProgress(progress);
  };

  // Collect from first page
  for (const part of firstResult.parts) {
    if (part.componentCode) {
      buffer.push({ lcsc: part.componentCode.toUpperCase(), stockCount: part.stockCount ?? 0 });
    }
    totalFetched++;
  }

  // Remaining pages — fetch in parallel batches
  let page = startPage + 1;
  while (page <= totalPages) {
    if (isStopping()) {
      await flush();
      return { fetched: totalFetched, updated: totalUpdatedThisQuery, stopped: true };
    }

    if (buffer.length >= FLUSH_THRESHOLD) {
      await flush();
    }

    // Build batch of up to BATCH_CONCURRENCY pages
    const batchEnd = Math.min(page + BATCH_CONCURRENCY, totalPages + 1);
    const pageNums = Array.from({ length: batchEnd - page }, (_, i) => page + i);
    const results = await Promise.all(pageNums.map((p) => fetchPage(params, p)));

    let hitEmpty = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result || result.parts.length === 0) { hitEmpty = true; break; }
      for (const part of result.parts) {
        if (part.componentCode) {
          buffer.push({ lcsc: part.componentCode.toUpperCase(), stockCount: part.stockCount ?? 0 });
        }
        totalFetched++;
      }
    }

    page = batchEnd;
    progress.currentPage = page - 1;

    if (page % 50 < BATCH_CONCURRENCY || page > totalPages) {
      const pct = ((Math.min(page, totalPages) / totalPages) * 100).toFixed(0);
      console.log(`    Page ${Math.min(page, totalPages)}/${totalPages} (${pct}%), fetched: ${totalFetched.toLocaleString()}, updated: ${progress.totalUpdated.toLocaleString()} total`);
    }

    if (hitEmpty) break;
    await Bun.sleep(DELAY_MS);
  }

  await flush();
  return { fetched: totalFetched, updated: totalUpdatedThisQuery, stopped: false };
}

// ── Main ──

async function main() {
  const isFresh = process.argv.includes("--fresh");

  const sql = postgres(DATABASE_URL, { max: 10, onnotice: () => {} });

  // Verify connection
  const [{ cnt }] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  console.log(`Connected to database. Parts in DB: ${Number(cnt).toLocaleString()}`);

  // Check current jlc_stock state
  const [{ populated }] = await sql`SELECT COUNT(*) AS populated FROM parts WHERE jlc_stock > 0`;
  console.log(`Parts with jlc_stock > 0: ${Number(populated).toLocaleString()}`);

  mkdirSync("data", { recursive: true });

  let progress = loadProgress();
  if (isFresh) {
    progress = {
      completedCategories: [],
      currentCategory: null,
      currentPage: 1,
      totalUpdated: 0,
    };
    console.log("Starting fresh (--fresh flag)");
  } else if (progress.completedCategories.length > 0 || progress.currentCategory) {
    console.log(`Resuming: ${progress.completedCategories.length} categories done, ${progress.totalUpdated.toLocaleString()} parts updated`);
    if (progress.currentCategory) {
      console.log(`  Resuming category "${progress.currentCategory}" from page ${progress.currentPage}`);
    }
  }

  // Graceful shutdown
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) {
      console.log("\n  Force quit.");
      process.exit(1);
    }
    stopping = true;
    console.log("\n  Stopping after current operation... (Ctrl+C again to force quit)");
  });

  const startTime = Date.now();

  for (const category of CATEGORIES) {
    if (stopping) break;

    // Skip completed categories
    if (progress.completedCategories.includes(category)) {
      continue;
    }

    console.log(`\n[${category}]`);

    // Determine start page for resume
    let startPage = 1;
    if (progress.currentCategory === category && progress.currentPage > 1) {
      startPage = progress.currentPage;
      console.log(`  Resuming from page ${startPage}`);
    }

    progress.currentCategory = category;
    progress.currentPage = startPage;
    saveProgress(progress);

    // Probe category size
    const probeResult = await fetchPage({ firstSortName: category }, 1);
    if (!probeResult || probeResult.parts.length === 0) {
      console.log(`  No results, skipping`);
      progress.completedCategories.push(category);
      progress.currentCategory = null;
      progress.currentPage = 1;
      saveProgress(progress);
      continue;
    }

    const categoryTotal = probeResult.total;

    if (categoryTotal <= MAX_FETCHABLE) {
      // Category fits in a single query
      const result = await processQuery(
        sql,
        { firstSortName: category },
        category,
        startPage,
        progress,
        () => stopping,
      );

      if (result.stopped) {
        console.log(`  Stopped. Updated ${result.updated.toLocaleString()} parts this category.`);
        break;
      }

      console.log(`  Done: ${result.fetched.toLocaleString()} fetched, ${result.updated.toLocaleString()} updated`);
    } else {
      // Category too large -- split by subcategory
      console.log(`  ${categoryTotal.toLocaleString()} parts -- splitting by subcategory`);
      const subcategories = await discoverSubcategories(category);
      console.log(`  Found ${subcategories.length} subcategories`);

      let categoryUpdated = 0;
      let categoryStopped = false;

      for (const sub of subcategories) {
        if (stopping) {
          categoryStopped = true;
          break;
        }

        await Bun.sleep(DELAY_MS);

        const result = await processQuery(
          sql,
          { firstSortName: category, secondSortName: sub },
          `${category} > ${sub}`,
          1, // subcategory queries always start from page 1 (resume is at category level)
          progress,
          () => stopping,
        );

        categoryUpdated += result.updated;

        if (result.stopped) {
          categoryStopped = true;
          break;
        }
      }

      if (categoryStopped) {
        console.log(`  Stopped mid-category. Updated ${categoryUpdated.toLocaleString()} parts so far.`);
        break;
      }

      console.log(`  Done: ${categoryUpdated.toLocaleString()} updated across ${subcategories.length} subcategories`);
    }

    if (!stopping) {
      progress.completedCategories.push(category);
      progress.currentCategory = null;
      progress.currentPage = 1;
      saveProgress(progress);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  if (stopping) {
    console.log("\n=== Stopped by user ===");
    console.log(`  Categories completed: ${progress.completedCategories.length}/${CATEGORIES.length}`);
    console.log(`  Total parts updated:  ${progress.totalUpdated.toLocaleString()}`);
    console.log(`  Duration:             ${elapsed} minutes`);
    console.log(`  Progress saved. Resume with: bun run scripts/backfill-jlc-stock.ts`);
    saveProgress(progress);
  } else {
    // Final stats
    const [{ finalPopulated }] = await sql`SELECT COUNT(*) AS "finalPopulated" FROM parts WHERE jlc_stock > 0`;

    console.log("\n=== JLC Stock Backfill Complete ===");
    console.log(`  Categories processed:     ${progress.completedCategories.length}`);
    console.log(`  Total parts updated:      ${progress.totalUpdated.toLocaleString()}`);
    console.log(`  Parts with jlc_stock > 0: ${Number(finalPopulated).toLocaleString()}`);
    console.log(`  Duration:                 ${elapsed} minutes`);

    // Clean up progress file on success
    try { unlinkSync(PROGRESS_FILE); } catch {}
  }

  await sql.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
