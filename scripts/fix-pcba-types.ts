/**
 * Bulk-update pcba_type column using JLCPCB's component list API.
 *
 * The API returns `componentProductType` per part:
 *   0 = "Economic+Standard"
 *   2 = "Standard"
 *
 * This script iterates through all JLCPCB categories, fetching every page,
 * and batch-updates the DB. It is safe to re-run (idempotent UPDATEs).
 *
 * Usage: bun run scripts/fix-pcba-types.ts [--dry-run] [--category "Resistors"]
 *
 * Options:
 *   --dry-run              Print what would be updated without writing to DB
 *   --category "Name"      Only process a single category (for testing/debugging)
 */
import postgres from "postgres";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// ── Config ──

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jlc:jlc@localhost:5432/jlc";
const API_URL =
  "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList";
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_FETCHABLE = MAX_PAGES * PAGE_SIZE; // 100,000
const DELAY_MS = 200;
const DB_BATCH_SIZE = 500; // parts per UPDATE statement
const CONCURRENCY = 3;     // parallel category fetches
const PROGRESS_FILE = "data/pcba-fix-progress.json";

// ── CLI args ──

const DRY_RUN = process.argv.includes("--dry-run");
const categoryArgIdx = process.argv.indexOf("--category");
const SINGLE_CATEGORY = categoryArgIdx !== -1 ? process.argv[categoryArgIdx + 1] : null;

// ── All known JLCPCB categories (firstSortName values) ──

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
  // Alternate/renamed category names (JLCPCB changes these periodically)
  "Transistors/Thyristors", "Power Management (PMIC)",
  "Amplifiers/Comparators", "Data Acquisition", "Optoisolators",
  "Signal Isolation Devices", "RF and Wireless", "Clock/Timing",
  "Silicon Carbide (SiC) Devices", "Magnetic Sensors",
  "Gallium Nitride (GaN) Devices",
  // Legacy names (kept for completeness, may return 0)
  "Amplifiers", "Data Converters", "Clock and Timing",
  "Power Management", "RF And Wireless", "Isolators",
  "Battery Products", "Fuses", "Wires And Cables",
  "Buzzers & Speakers & Microphones", "Industrial Control Electrical",
  "Transistors", "Consumables",
];

// ── Types ──

interface QueryParams {
  firstSortName: string;
  secondSortName?: string;
}

interface ApiPart {
  componentCode: string;
  componentProductType?: number;
  firstSortName?: string;
}

interface Progress {
  completedQueries: string[];
  totalUpdated: number;
  economicCount: number;
  standardCount: number;
  startedAt: string;
}

interface PcbaUpdate {
  lcsc: string;
  pcba_type: string;
}

// ── Progress persistence ──

function loadProgress(): Progress {
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
    if (!Array.isArray(raw.completedQueries) || typeof raw.totalUpdated !== "number") {
      throw new Error("invalid shape");
    }
    return raw as Progress;
  } catch {
    return {
      completedQueries: [],
      totalUpdated: 0,
      economicCount: 0,
      standardCount: 0,
      startedAt: new Date().toISOString(),
    };
  }
}

function saveProgress(progress: Progress): void {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── API fetch with retry ──

async function fetchPage(
  params: QueryParams,
  page: number,
): Promise<{ parts: ApiPart[]; total: number } | null> {
  const body: Record<string, unknown> = {
    keyword: "",
    pageSize: PAGE_SIZE,
    currentPage: page,
    firstSortName: params.firstSortName,
  };
  if (params.secondSortName !== undefined) {
    body.secondSortName = params.secondSortName;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        console.error(`  HTTP ${resp.status} for ${params.firstSortName} page ${page}, attempt ${attempt + 1}`);
        await Bun.sleep(2000 * (attempt + 1));
        continue;
      }

      const data = (await resp.json()) as {
        code: number;
        data?: {
          componentPageInfo?: {
            total: number;
            list: ApiPart[] | null;
          };
        };
      };

      if (data.code !== 200 || !data.data?.componentPageInfo?.list) {
        if (attempt < 2) {
          await Bun.sleep(2000 * (attempt + 1));
          continue;
        }
        return null;
      }

      return {
        parts: data.data.componentPageInfo.list,
        total: data.data.componentPageInfo.total,
      };
    } catch (err) {
      console.error(`  Fetch error for ${params.firstSortName} page ${page}: ${err}, attempt ${attempt + 1}`);
      await Bun.sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// ── Subcategory discovery (for categories exceeding 100k parts) ──

async function discoverSubcategories(category: string): Promise<string[]> {
  const seen = new Set<string>();
  // Sample from multiple pages to discover subcategory names
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

// ── Convert componentProductType to pcba_type string ──

function mapPcbaType(componentProductType: number | undefined): string {
  return componentProductType === 2 ? "Standard" : "Economic+Standard";
}

// ── Batch DB update ──

async function flushUpdates(
  sql: ReturnType<typeof postgres>,
  updates: PcbaUpdate[],
  progress: Progress,
): Promise<number> {
  if (updates.length === 0) return 0;
  if (DRY_RUN) {
    const econ = updates.filter(u => u.pcba_type === "Economic+Standard").length;
    const std = updates.filter(u => u.pcba_type === "Standard").length;
    console.log(`  [dry-run] Would update ${updates.length} parts (${econ} Economic+Standard, ${std} Standard)`);
    return updates.length;
  }

  let totalChanged = 0;

  // Process in sub-batches to avoid overly large SQL statements
  for (let i = 0; i < updates.length; i += DB_BATCH_SIZE) {
    const batch = updates.slice(i, i + DB_BATCH_SIZE);

    // Separate into Economic+Standard and Standard groups for simpler SQL
    const economic = batch.filter(u => u.pcba_type === "Economic+Standard").map(u => u.lcsc);
    const standard = batch.filter(u => u.pcba_type === "Standard").map(u => u.lcsc);

    if (economic.length > 0) {
      const result = await sql`
        UPDATE parts SET pcba_type = 'Economic+Standard'
        WHERE lcsc = ANY(${economic}) AND pcba_type != 'Economic+Standard'
      `;
      totalChanged += result.count;
      progress.economicCount += economic.length;
    }

    if (standard.length > 0) {
      const result = await sql`
        UPDATE parts SET pcba_type = 'Standard'
        WHERE lcsc = ANY(${standard}) AND pcba_type != 'Standard'
      `;
      totalChanged += result.count;
      progress.standardCount += standard.length;
    }
  }

  progress.totalUpdated += updates.length;
  return totalChanged;
}

// ── Query builder: split large categories into sub-queries ──

interface WorkItem {
  key: string;
  label: string;
  params: QueryParams;
}

async function buildWorkQueue(): Promise<WorkItem[]> {
  const queue: WorkItem[] = [];
  const categories = SINGLE_CATEGORY ? [SINGLE_CATEGORY] : CATEGORIES;

  for (const category of categories) {
    const result = await fetchPage({ firstSortName: category }, 1);
    await Bun.sleep(DELAY_MS);
    const total = result?.total ?? 0;

    if (total === 0) {
      console.log(`  [plan] ${category}: 0 parts, skipping`);
      continue;
    }

    if (total <= MAX_FETCHABLE) {
      queue.push({
        key: category,
        label: `${category} [${total.toLocaleString()}]`,
        params: { firstSortName: category },
      });
      console.log(`  [plan] ${category}: ${total.toLocaleString()} parts`);
      continue;
    }

    // Category too large: split by subcategory (secondSortName)
    console.log(`  [plan] ${category}: ${total.toLocaleString()} parts -- splitting by subcategory`);
    const subcategories = await discoverSubcategories(category);
    console.log(`         Found ${subcategories.length} subcategories`);

    for (const sub of subcategories) {
      const subResult = await fetchPage({ firstSortName: category, secondSortName: sub }, 1);
      await Bun.sleep(DELAY_MS);
      const subTotal = subResult?.total ?? 0;

      if (subTotal === 0) continue;

      const capped = subTotal > MAX_FETCHABLE ? ` (capped from ${subTotal.toLocaleString()})` : "";
      queue.push({
        key: `${category} > ${sub}`,
        label: `${category} > ${sub} [${Math.min(subTotal, MAX_FETCHABLE).toLocaleString()}${capped}]`,
        params: { firstSortName: category, secondSortName: sub },
      });
      console.log(`         ${sub}: ${subTotal.toLocaleString()}`);
    }
  }

  return queue;
}

// ── Process a single work item (category or subcategory) ──

async function processWorkItem(
  sql: ReturnType<typeof postgres>,
  item: WorkItem,
  progress: Progress,
): Promise<{ fetched: number; changed: number }> {
  const firstResult = await fetchPage(item.params, 1);
  if (!firstResult || firstResult.parts.length === 0) {
    console.log(`  [${item.label}] No results, skipping`);
    return { fetched: 0, changed: 0 };
  }

  const totalParts = firstResult.total;
  const totalPages = Math.min(Math.ceil(totalParts / PAGE_SIZE), MAX_PAGES);

  let updates: PcbaUpdate[] = [];
  let fetched = 0;
  let totalChanged = 0;

  // Process first page
  for (const part of firstResult.parts) {
    if (part.componentCode) {
      updates.push({
        lcsc: part.componentCode.toUpperCase(),
        pcba_type: mapPcbaType(part.componentProductType),
      });
      fetched++;
    }
  }

  // Remaining pages
  for (let page = 2; page <= totalPages; page++) {
    // Flush accumulated updates periodically
    if (updates.length >= DB_BATCH_SIZE) {
      totalChanged += await flushUpdates(sql, updates, progress);
      updates = [];
      saveProgress(progress);
    }

    await Bun.sleep(DELAY_MS);
    const result = await fetchPage(item.params, page);
    if (!result || result.parts.length === 0) break;

    for (const part of result.parts) {
      if (part.componentCode) {
        updates.push({
          lcsc: part.componentCode.toUpperCase(),
          pcba_type: mapPcbaType(part.componentProductType),
        });
        fetched++;
      }
    }

    if (page % 100 === 0 || page === totalPages) {
      const pct = ((page / totalPages) * 100).toFixed(0);
      console.log(`    Page ${page}/${totalPages} (${pct}%) -- ${fetched.toLocaleString()} parts`);
    }
  }

  // Final flush
  totalChanged += await flushUpdates(sql, updates, progress);
  saveProgress(progress);

  return { fetched, changed: totalChanged };
}

// ── Concurrency limiter ──

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      if (stopping) return;
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

// ── Graceful shutdown ──

let stopping = false;

// ── Main ──

async function main() {
  console.log("=== JLCPCB pcba_type bulk updater ===");
  if (DRY_RUN) console.log("  (DRY RUN: no DB writes)");
  console.log();

  const sql = postgres(DATABASE_URL, { max: 10, onnotice: () => {} });

  // Show current state
  const [totalRow] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const [econRow] = await sql`SELECT COUNT(*) AS cnt FROM parts WHERE pcba_type = 'Economic+Standard'`;
  const [stdRow] = await sql`SELECT COUNT(*) AS cnt FROM parts WHERE pcba_type = 'Standard'`;
  console.log(`DB state before:`);
  console.log(`  Total parts:        ${Number(totalRow.cnt).toLocaleString()}`);
  console.log(`  Economic+Standard:  ${Number(econRow.cnt).toLocaleString()}`);
  console.log(`  Standard:           ${Number(stdRow.cnt).toLocaleString()}`);
  console.log();

  // Load progress for resume support
  let progress = loadProgress();
  const isResuming = progress.completedQueries.length > 0;
  if (isResuming) {
    console.log(`Resuming: ${progress.completedQueries.length} queries already completed, ${progress.totalUpdated.toLocaleString()} parts processed`);
    console.log();
  }

  // Trap SIGINT for graceful stop
  process.on("SIGINT", () => {
    if (stopping) {
      console.log("\n  Force quit.");
      process.exit(1);
    }
    stopping = true;
    console.log("\n  Stopping after current work items finish... (Ctrl+C again to force quit)");
  });

  // Build work queue
  console.log("Building work queue (probing API for category sizes)...");
  const allItems = await buildWorkQueue();
  const pendingItems = allItems.filter(item => !progress.completedQueries.includes(item.key));

  console.log(`\nWork queue: ${allItems.length} queries total, ${pendingItems.length} pending\n`);

  if (pendingItems.length === 0) {
    console.log("Nothing to do. All queries already completed.");
    console.log("Delete the progress file to re-run: rm " + PROGRESS_FILE);
    await sql.end();
    return;
  }

  // Process with bounded concurrency
  let completedCount = allItems.length - pendingItems.length;
  let totalFetched = 0;
  let totalChanged = 0;

  await runWithConcurrency(pendingItems, CONCURRENCY, async (item) => {
    if (stopping) return;

    console.log(`\n[${++completedCount}/${allItems.length}] ${item.label}`);
    const result = await processWorkItem(sql, item, progress);
    totalFetched += result.fetched;
    totalChanged += result.changed;

    if (!stopping) {
      progress.completedQueries.push(item.key);
      saveProgress(progress);
      console.log(`  Done: ${result.fetched.toLocaleString()} fetched, ${result.changed.toLocaleString()} rows changed`);
    }
  });

  // Final stats
  if (stopping) {
    console.log("\n=== Stopped by user ===");
    console.log(`  Queries completed: ${progress.completedQueries.length}/${allItems.length}`);
  } else {
    // Clean up progress file on success
    try { unlinkSync(PROGRESS_FILE); } catch {}
  }

  // Show final DB state
  if (!DRY_RUN) {
    const [finalEcon] = await sql`SELECT COUNT(*) AS cnt FROM parts WHERE pcba_type = 'Economic+Standard'`;
    const [finalStd] = await sql`SELECT COUNT(*) AS cnt FROM parts WHERE pcba_type = 'Standard'`;
    console.log(`\nDB state after:`);
    console.log(`  Economic+Standard:  ${Number(finalEcon.cnt).toLocaleString()}`);
    console.log(`  Standard:           ${Number(finalStd.cnt).toLocaleString()}`);
  }

  console.log(`\nSummary:`);
  console.log(`  Parts checked:   ${totalFetched.toLocaleString()}`);
  console.log(`  Rows changed:    ${totalChanged.toLocaleString()}`);
  console.log(`  API Economic:    ${progress.economicCount.toLocaleString()}`);
  console.log(`  API Standard:    ${progress.standardCount.toLocaleString()}`);
  const elapsed = (Date.now() - new Date(progress.startedAt).getTime()) / 1000 / 60;
  console.log(`  Duration:        ${elapsed.toFixed(1)} minutes`);

  await sql.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
