/**
 * Ingest parts directly from JLCPCB's public API.
 * Merges into existing DB by LCSC code (ON CONFLICT DO UPDATE).
 *
 * JLCPCB API limits: 100 parts/page, max 1000 pages = 100k parts per query.
 * We use hierarchical sub-partitioning (category → subcategory → stock filter)
 * to maximize coverage beyond the 100k limit.
 *
 * Usage: bun run ingest/src/jlcpcb-api.ts [--fresh]
 *
 * Auto-resumes from data/jlcpcb-progress.json if a previous run was interrupted.
 * Ctrl+C stops gracefully: flushes current batch, saves progress, rebuilds search vectors.
 * Use --fresh to discard previous progress and start from scratch.
 */
import postgres from "postgres";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { applySchema } from "../../backend/src/schema.ts";
import { translateChinese } from "./chinese-dict.ts";
import { buildSearchText } from "./attrs.ts";
import {
  bulkInsertParts,
  recoverFromCrash,
  disableSearchTrigger,
  enableSearchTrigger,
  rebuildSearchVectors,
} from "./writer.ts";
import type { PartRow } from "./types.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jlc:jlc@localhost:5432/jlc";
const API_URL =
  "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList";
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_FETCHABLE = MAX_PAGES * PAGE_SIZE; // 100,000
const DELAY_MS = 300;
const BATCH_SIZE = 1000;

// CLI: --progress-file <path> to use a custom progress file (for parallel runs)
const progressFileIdx = process.argv.indexOf("--progress-file");
const PROGRESS_FILE = progressFileIdx !== -1 && process.argv[progressFileIdx + 1]
  ? process.argv[progressFileIdx + 1]
  : "data/jlcpcb-progress.json";

// CLI: --categories "Cat1|Cat2|..." to only process a subset of categories
// Use | as delimiter since some category names contain commas (e.g. "Crystals, Oscillators, Resonators")
// Also supports comma delimiter if no pipe is present (backward compat)
const categoriesIdx = process.argv.indexOf("--categories");
const CATEGORY_FILTER: string[] | null = categoriesIdx !== -1 && process.argv[categoriesIdx + 1]
  ? process.argv[categoriesIdx + 1].split(process.argv[categoriesIdx + 1].includes("|") ? "|" : ",").map(s => s.trim()).filter(s => s.length > 0)
  : null;

// CLI: --no-trigger-mgmt to skip trigger disable/enable/rebuild (for parallel runs; outer loop handles it)
const NO_TRIGGER_MGMT = process.argv.includes("--no-trigger-mgmt");

// CLI: --instock-only to force stockFlag=1 on ALL queries (only fetch in-stock parts)
const INSTOCK_ONLY = process.argv.includes("--instock-only");

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

interface JlcPart {
  componentCode: string;
  componentModelEn: string;
  componentBrandEn: string;
  firstSortName: string;
  secondSortName: string;
  describe: string;
  componentSpecificationEn: string;
  stockCount: number;
  componentPrices: { startNumber: number; endNumber: number; productPrice: number }[];
  componentImageUrl?: string;
  minImage?: string;
  dataManualUrl?: string;
  dataManualOfficialLink?: string;
  urlSuffix?: string;
  componentLibraryType: string;
  encapsulationNumber?: number;
  attributes?: Record<string, unknown>;
}

interface QueryParams {
  firstSortName: string;
  secondSortName?: string;
  stockFlag?: number;
  componentLibraryType?: string;
}

interface ApiQuery {
  key: string;
  label: string;
  params: QueryParams;
}

interface Progress {
  completedQueries: string[];
  currentQuery: string | null;
  currentPage: number;
  totalFetched: number;
  totalNew: number;
  startedAt: string;
}

// ── API fetch ──

async function fetchPage(
  params: QueryParams,
  page: number,
): Promise<{ parts: JlcPart[]; total: number } | null> {
  const body: Record<string, unknown> = {
    keyword: "",
    pageSize: PAGE_SIZE,
    currentPage: page,
    firstSortName: params.firstSortName,
  };
  if (params.secondSortName !== undefined) body.secondSortName = params.secondSortName;
  if (params.stockFlag !== undefined) body.stockFlag = params.stockFlag;
  if (params.componentLibraryType !== undefined) body.componentLibraryType = params.componentLibraryType;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        console.error(`  HTTP ${resp.status} for page ${page}, retrying...`);
        await Bun.sleep(2000 * (attempt + 1));
        continue;
      }

      const data = (await resp.json()) as {
        code: number;
        data?: {
          componentPageInfo?: {
            total: number;
            list: JlcPart[] | null;
          };
        };
      };

      if (data.code !== 200 || !data.data?.componentPageInfo?.list) return null;

      return {
        parts: data.data.componentPageInfo.list,
        total: data.data.componentPageInfo.total,
      };
    } catch (err) {
      console.error(`  Fetch error for page ${page}: ${err}, retrying...`);
      await Bun.sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

async function fetchTotal(params: QueryParams): Promise<number> {
  const result = await fetchPage(params, 1);
  await Bun.sleep(DELAY_MS);
  return result?.total ?? 0;
}

// ── Subcategory discovery ──

async function discoverSubcategories(category: string): Promise<string[]> {
  const seen = new Set<string>();
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

// ── Query planner ──

function buildQueryKey(params: QueryParams): string {
  const parts: string[] = [params.firstSortName];
  if (params.secondSortName) parts.push(params.secondSortName);
  if (params.stockFlag === 1) parts.push("instock");
  if (params.componentLibraryType) parts.push(params.componentLibraryType);
  return parts.join(" > ");
}

async function buildWorkQueue(): Promise<ApiQuery[]> {
  const queue: ApiQuery[] = [];
  const categoriesToProcess = CATEGORY_FILTER ?? CATEGORIES;

  for (const category of categoriesToProcess) {
    // In --instock-only mode, always filter by stock
    const baseStock: Pick<QueryParams, "stockFlag"> = INSTOCK_ONLY ? { stockFlag: 1 } : {};

    const catParams: QueryParams = { firstSortName: category, ...baseStock };
    const catTotal = await fetchTotal(catParams);

    if (catTotal === 0) {
      console.log(`[planner] ${category}: 0 parts, skipping`);
      continue;
    }

    if (catTotal <= MAX_FETCHABLE) {
      const params: QueryParams = { firstSortName: category, ...baseStock };
      queue.push({ key: buildQueryKey(params), label: `${category} [${catTotal.toLocaleString()}]`, params });
      console.log(`[planner] ${category}: ${catTotal.toLocaleString()} — single query`);
      continue;
    }

    // Category too large — split by subcategory
    console.log(`[planner] ${category}: ${catTotal.toLocaleString()} — splitting by subcategory`);
    const subcategories = await discoverSubcategories(category);
    console.log(`  Found ${subcategories.length} subcategories`);

    for (const sub of subcategories) {
      const subParams: QueryParams = { firstSortName: category, secondSortName: sub, ...baseStock };
      const subTotal = await fetchTotal(subParams);

      if (subTotal <= MAX_FETCHABLE) {
        queue.push({
          key: buildQueryKey(subParams),
          label: `${category} > ${sub} [${subTotal.toLocaleString()}]`,
          params: subParams,
        });
        console.log(`  ${sub}: ${subTotal.toLocaleString()} — single query`);
        continue;
      }

      // Subcategory still too large (even with instock filter) — add capped query
      // In instock-only mode, we can't split further, so just cap at 100k
      if (INSTOCK_ONLY) {
        queue.push({
          key: buildQueryKey(subParams),
          label: `${category} > ${sub} [capped at 100k of ${subTotal.toLocaleString()}]`,
          params: subParams,
        });
        console.log(`  ${sub}: ${subTotal.toLocaleString()} — capped at 100k (instock-only)`);
        continue;
      }

      // Not instock-only: add in-stock query + capped all-parts query
      const instockParams: QueryParams = { ...subParams, stockFlag: 1 };
      const instockTotal = await fetchTotal(instockParams);

      queue.push({
        key: buildQueryKey(instockParams),
        label: `${category} > ${sub} [instock: ${instockTotal.toLocaleString()}]`,
        params: instockParams,
      });
      queue.push({
        key: buildQueryKey(subParams),
        label: `${category} > ${sub} [all: capped at 100k of ${subTotal.toLocaleString()}]`,
        params: subParams,
      });
      console.log(`  ${sub}: ${subTotal.toLocaleString()} — split: instock (${instockTotal.toLocaleString()}) + all (capped 100k)`);
    }
  }

  console.log(`\n[planner] Work queue: ${queue.length} queries`);
  return queue;
}

// ── Convert API part to PartRow ──

function mapPartType(libraryType: string): string {
  switch (libraryType) {
    case "base": return "Basic";
    case "preferred": return "Preferred";
    default: return "Extended";
  }
}

function formatPrices(
  prices: { startNumber: number; endNumber: number; productPrice: number }[],
): string {
  if (!prices || prices.length === 0) return "";
  return prices
    .sort((a, b) => a.startNumber - b.startNumber)
    .map((p) => `${p.startNumber}-${p.endNumber > 0 ? p.endNumber : ""}:${p.productPrice}`)
    .join(",");
}

function convertPart(p: JlcPart): PartRow {
  const lcsc = (p.componentCode || "").toUpperCase();
  const partType = mapPartType(p.componentLibraryType);
  const pcbaType =
    partType === "Extended" || partType === "Mechanical"
      ? "Standard"
      : "Economic+Standard";
  const attrsJson = JSON.stringify(p.attributes ?? {});

  return {
    lcsc,
    mpn: translateChinese(p.componentModelEn || ""),
    manufacturer: p.componentBrandEn || null,
    category: p.secondSortName || "",
    subcategory: p.firstSortName || "",
    description: p.describe || "",
    datasheet: p.dataManualOfficialLink || p.dataManualUrl || null,
    package: translateChinese(p.componentSpecificationEn || "") || null,
    joints: p.encapsulationNumber ?? null,
    stock: p.stockCount || 0,
    price_raw: formatPrices(p.componentPrices || []),
    img: p.minImage || p.componentImageUrl || null,
    url: p.urlSuffix || null,
    part_type: partType,
    pcba_type: pcbaType,
    attributes: attrsJson,
    search_text: buildSearchText(attrsJson),
  };
}

// ── Progress tracking ──

function loadProgress(): Progress {
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
    // Validate shape — reject old format (completedCategories) or corrupt data
    if (!Array.isArray(raw.completedQueries) || typeof raw.totalFetched !== "number") {
      throw new Error("invalid shape");
    }
    return raw as Progress;
  } catch {
    return {
      completedQueries: [],
      currentQuery: null,
      currentPage: 1,
      totalFetched: 0,
      totalNew: 0,
      startedAt: new Date().toISOString(),
    };
  }
}

function saveProgress(progress: Progress): void {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function isQueryDone(progress: Progress, key: string): boolean {
  return progress.completedQueries.includes(key);
}

function getResumeInfo(progress: Progress, key: string): { startPage: number } | null {
  if (progress.currentQuery === key && progress.currentPage > 1) {
    return { startPage: progress.currentPage };
  }
  return null;
}

// ── Graceful shutdown ──

let stopping = false;

async function cleanup(sql: ReturnType<typeof postgres>, progress: Progress) {
  if (!NO_TRIGGER_MGMT) {
    console.log("\n  Rebuilding search vectors for inserted parts...");
    await rebuildSearchVectors(sql);
    await enableSearchTrigger(sql);
  }
  saveProgress(progress);
  console.log(`  Progress saved. Resume with: bun run ingest/src/jlcpcb-api.ts`);
  await sql.end();
}

// ── Main ──

async function main() {
  const isFresh = process.argv.includes("--fresh");

  const sql = postgres(DATABASE_URL, { max: 10, onnotice: () => {} });
  await applySchema(sql);
  await recoverFromCrash(sql);

  const [existing] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const existingCount = Number(existing?.cnt ?? 0);
  console.log(`Existing parts in DB: ${existingCount.toLocaleString()}`);

  if (!NO_TRIGGER_MGMT) await disableSearchTrigger(sql);

  let progress = loadProgress();
  if (isFresh) {
    progress = {
      completedQueries: [],
      currentQuery: null,
      currentPage: 1,
      totalFetched: 0,
      totalNew: 0,
      startedAt: new Date().toISOString(),
    };
  }

  // Trap SIGINT for graceful stop
  process.on("SIGINT", () => {
    if (stopping) {
      console.log("\n  Force quit.");
      process.exit(1);
    }
    stopping = true;
    console.log("\n  Stopping after current batch... (Ctrl+C again to force quit)");
  });

  // Build work queue (probes API for totals, discovers subcategories)
  console.log("\nBuilding work queue (probing API for category sizes)...\n");
  const allQueries = await buildWorkQueue();

  const pendingQueries = allQueries.filter((q) => !isQueryDone(progress, q.key));
  const doneCount = allQueries.length - pendingQueries.length;

  const isResuming = doneCount > 0 || progress.currentQuery != null;
  console.log(`\nWork queue: ${allQueries.length} queries — ${doneCount} done, ${pendingQueries.length} pending`);
  if (isResuming) {
    console.log(`  Resuming: ${progress.totalFetched.toLocaleString()} parts fetched previously`);
  }

  for (const query of pendingQueries) {
    if (stopping) break;

    const resumeInfo = getResumeInfo(progress, query.key);
    const startPage = resumeInfo?.startPage ?? 1;

    if (startPage > 1) {
      console.log(`\n[${query.label}] Resuming from page ${startPage}...`);
    }

    progress.currentQuery = query.key;
    progress.currentPage = startPage;

    const firstResult = await fetchPage(query.params, startPage);
    if (!firstResult || firstResult.parts.length === 0) {
      console.log(`[${query.label}] No results, skipping`);
      progress.completedQueries.push(query.key);
      progress.currentQuery = null;
      saveProgress(progress);
      continue;
    }

    const totalParts = firstResult.total;
    const totalPages = Math.min(Math.ceil(totalParts / PAGE_SIZE), MAX_PAGES);
    const cappedParts = Math.min(totalParts, MAX_FETCHABLE);
    const cappedNote = totalParts > MAX_FETCHABLE
      ? ` (capped from ${totalParts.toLocaleString()})`
      : "";
    console.log(`\n[${query.label}] ${cappedParts.toLocaleString()}${cappedNote} parts, ${totalPages} pages`);

    let batch: PartRow[] = [];
    let queryFetched = 0;

    const flushBatch = async () => {
      if (batch.length === 0) return;
      const stats = await bulkInsertParts(sql, batch);
      progress.totalNew += stats.inserted;
      batch = [];
      saveProgress(progress);
    };

    for (const part of firstResult.parts) {
      batch.push(convertPart(part));
      queryFetched++;
      progress.totalFetched++;
    }

    for (let page = startPage + 1; page <= totalPages; page++) {
      if (stopping) break;
      if (batch.length >= BATCH_SIZE) await flushBatch();

      await Bun.sleep(DELAY_MS);
      const result = await fetchPage(query.params, page);
      if (!result || result.parts.length === 0) break;

      for (const part of result.parts) {
        batch.push(convertPart(part));
        queryFetched++;
        progress.totalFetched++;
      }

      progress.currentPage = page;

      if (page % 50 === 0) {
        const pct = ((page / totalPages) * 100).toFixed(0);
        console.log(
          `  Page ${page}/${totalPages} (${pct}%) — ${queryFetched.toLocaleString()} this query, ${progress.totalFetched.toLocaleString()} total`,
        );
      }
    }

    await flushBatch();

    if (!stopping) {
      progress.completedQueries.push(query.key);
      progress.currentQuery = null;
      saveProgress(progress);
      console.log(`  Done: ${queryFetched.toLocaleString()} parts from ${query.label}`);
    }
  }

  if (stopping) {
    console.log("\n=== Stopped by user ===");
    console.log(`  Parts fetched so far: ${progress.totalFetched.toLocaleString()}`);
    console.log(`  New parts inserted: ${progress.totalNew.toLocaleString()}`);
    console.log(`  Queries completed: ${progress.completedQueries.length}/${allQueries.length}`);
    await cleanup(sql, progress);
    return;
  }

  // Rebuild search vectors and re-enable trigger
  if (!NO_TRIGGER_MGMT) {
    await rebuildSearchVectors(sql);
    await enableSearchTrigger(sql);
  }

  // Final stats
  const [finalRow] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const finalCount = Number(finalRow?.cnt ?? 0);

  console.log("\n=== JLCPCB API Ingestion Complete ===");
  console.log(`  Queries processed:  ${progress.completedQueries.length}`);
  console.log(`  Parts fetched:      ${progress.totalFetched.toLocaleString()}`);
  console.log(`  New parts inserted: ${progress.totalNew.toLocaleString()}`);
  console.log(`  Parts updated:      ${(progress.totalFetched - progress.totalNew).toLocaleString()}`);
  console.log(`  Parts before:       ${existingCount.toLocaleString()}`);
  console.log(`  Parts after:        ${finalCount.toLocaleString()}`);
  console.log(
    `  Duration:           ${((Date.now() - new Date(progress.startedAt).getTime()) / 1000 / 60).toFixed(1)} minutes`,
  );

  try { unlinkSync(PROGRESS_FILE); } catch {}
  await sql.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
