/**
 * Ingest parts directly from JLCPCB's public API.
 * Merges into existing DB by LCSC code (ON CONFLICT DO UPDATE).
 *
 * JLCPCB API limits: 100 parts/page, max 1000 pages = 100k parts per query.
 * We partition by firstSortName (category) to maximize coverage.
 *
 * Usage: bun run ingest/src/jlcpcb-api.ts [--resume]
 *
 * Progress is saved to data/jlcpcb-progress.json for resume capability.
 * Estimated runtime: 3-6 hours for full ingestion.
 */
import postgres from "postgres";
import { applySchema } from "../../backend/src/schema.ts";
import { translateChinese } from "./chinese-dict.ts";
import { buildSearchText, extractNumericAttrs } from "./attrs.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jst:jst@localhost:5432/jst";
const PROGRESS_FILE = "data/jlcpcb-progress.json";
const API_URL =
  "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList";
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const DELAY_MS = 300;
const BATCH_SIZE = 500;

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

interface Progress {
  completedCategories: string[];
  currentCategory: string | null;
  currentPage: number;
  totalFetched: number;
  totalNew: number;
  startedAt: string;
}

// ── API fetch ──

async function fetchPage(
  category: string,
  page: number,
): Promise<{ parts: JlcPart[]; total: number } | null> {
  const body = {
    keyword: "",
    pageSize: PAGE_SIZE,
    currentPage: page,
    firstSortName: category,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        console.error(`  HTTP ${resp.status} for ${category} page ${page}, retrying...`);
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
      console.error(`  Fetch error for ${category} page ${page}: ${err}, retrying...`);
      await Bun.sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// ── Convert API part to DB row ──

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

function convertPart(p: JlcPart) {
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

// ── DB operations ──

const INSERT_COLS = [
  "lcsc", "mpn", "manufacturer", "category", "subcategory", "description",
  "datasheet", "package", "joints", "stock", "price_raw", "img", "url",
  "part_type", "pcba_type", "attributes", "search_text",
] as const;

async function insertBatch(
  sql: ReturnType<typeof postgres>,
  parts: ReturnType<typeof convertPart>[],
): Promise<number> {
  const valid = parts.filter((p) => p.lcsc);
  if (valid.length === 0) return 0;

  await sql`
    INSERT INTO parts ${sql(valid, ...INSERT_COLS)}
    ON CONFLICT (lcsc) DO UPDATE SET
      mpn = EXCLUDED.mpn, manufacturer = EXCLUDED.manufacturer,
      category = EXCLUDED.category, subcategory = EXCLUDED.subcategory,
      description = EXCLUDED.description, datasheet = EXCLUDED.datasheet,
      package = EXCLUDED.package, joints = EXCLUDED.joints,
      stock = EXCLUDED.stock, price_raw = EXCLUDED.price_raw,
      img = EXCLUDED.img, url = EXCLUDED.url,
      part_type = EXCLUDED.part_type, pcba_type = EXCLUDED.pcba_type,
      attributes = EXCLUDED.attributes, search_text = EXCLUDED.search_text
  `;

  // Numeric attributes
  const lcscs = valid.map((p) => p.lcsc);
  await sql`DELETE FROM part_nums WHERE lcsc IN ${sql(lcscs)}`;

  const numRows: { lcsc: string; unit: string; value: number }[] = [];
  for (const p of valid) {
    for (const { unit, value } of extractNumericAttrs(p.attributes, p.description)) {
      numRows.push({ lcsc: p.lcsc, unit, value });
    }
  }
  if (numRows.length > 0) {
    const NC = 5000;
    for (let i = 0; i < numRows.length; i += NC) {
      await sql`INSERT INTO part_nums ${sql(numRows.slice(i, i + NC), "lcsc", "unit", "value")}`;
    }
  }

  return valid.length;
}

// ── Progress tracking ──

function loadProgress(): Progress {
  try {
    const text = require("fs").readFileSync(PROGRESS_FILE, "utf8");
    return JSON.parse(text) as Progress;
  } catch {
    return {
      completedCategories: [],
      currentCategory: null,
      currentPage: 1,
      totalFetched: 0,
      totalNew: 0,
      startedAt: new Date().toISOString(),
    };
  }
}

function saveProgress(progress: Progress): void {
  require("fs").writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── Main ──

async function main() {
  const isResume = process.argv.includes("--resume");

  const sql = postgres(DATABASE_URL, { max: 10 });
  await applySchema(sql);

  // Count existing parts
  const [existing] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const existingCount = Number(existing?.cnt ?? 0);
  console.log(`Existing parts in DB: ${existingCount.toLocaleString()}`);

  // Disable search trigger for bulk performance
  await sql`ALTER TABLE parts DISABLE TRIGGER trg_parts_search_vec`;

  let progress = loadProgress();
  if (!isResume) {
    progress = {
      completedCategories: [],
      currentCategory: null,
      currentPage: 1,
      totalFetched: 0,
      totalNew: 0,
      startedAt: new Date().toISOString(),
    };
  }

  console.log(`\nStarting JLCPCB API ingestion (${CATEGORIES.length} categories)...`);
  if (isResume && progress.completedCategories.length > 0) {
    console.log(
      `  Resuming: ${progress.completedCategories.length} categories already done, ${progress.totalFetched.toLocaleString()} parts fetched`,
    );
  }

  const pendingCategories = CATEGORIES.filter(
    (c) => !progress.completedCategories.includes(c),
  );

  for (const category of pendingCategories) {
    let startPage = 1;
    if (progress.currentCategory === category && progress.currentPage > 1) {
      startPage = progress.currentPage;
      console.log(`\n[${category}] Resuming from page ${startPage}...`);
    } else {
      progress.currentCategory = category;
      progress.currentPage = 1;
    }

    const firstResult = await fetchPage(category, startPage);
    if (!firstResult || firstResult.parts.length === 0) {
      console.log(`[${category}] No results, skipping`);
      progress.completedCategories.push(category);
      progress.currentCategory = null;
      saveProgress(progress);
      continue;
    }

    const totalParts = firstResult.total;
    const totalPages = Math.min(Math.ceil(totalParts / PAGE_SIZE), MAX_PAGES);
    const cappedParts = Math.min(totalParts, MAX_PAGES * PAGE_SIZE);
    const cappedNote = totalParts > cappedParts
      ? ` (capped from ${totalParts.toLocaleString()})`
      : "";
    console.log(`\n[${category}] ${cappedParts.toLocaleString()}${cappedNote} parts, ${totalPages} pages`);

    let batch: ReturnType<typeof convertPart>[] = [];
    let categoryFetched = 0;

    const processBatch = async () => {
      if (batch.length === 0) return;
      const inserted = await insertBatch(sql, batch);
      progress.totalNew += inserted;
      batch = [];
    };

    for (const part of firstResult.parts) {
      batch.push(convertPart(part));
      categoryFetched++;
      progress.totalFetched++;
    }

    for (let page = startPage + 1; page <= totalPages; page++) {
      if (batch.length >= BATCH_SIZE) await processBatch();

      await Bun.sleep(DELAY_MS);
      const result = await fetchPage(category, page);
      if (!result || result.parts.length === 0) break;

      for (const part of result.parts) {
        batch.push(convertPart(part));
        categoryFetched++;
        progress.totalFetched++;
      }

      progress.currentPage = page;

      if (page % 50 === 0) {
        await processBatch();
        saveProgress(progress);
        const pct = ((page / totalPages) * 100).toFixed(0);
        console.log(
          `  Page ${page}/${totalPages} (${pct}%) — ${categoryFetched.toLocaleString()} parts this category, ${progress.totalFetched.toLocaleString()} total`,
        );
      }
    }

    await processBatch();
    progress.completedCategories.push(category);
    progress.currentCategory = null;
    saveProgress(progress);
    console.log(`  Done: ${categoryFetched.toLocaleString()} parts ingested from ${category}`);
  }

  // Rebuild search vectors and re-enable trigger
  console.log("\nRebuilding search vectors...");
  await sql`
    UPDATE parts SET search_vec =
      setweight(to_tsvector('simple', coalesce(lcsc, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(mpn, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(manufacturer, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(subcategory, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(search_text, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(package, '')), 'D')
    WHERE search_vec IS NULL
  `;
  await sql`ALTER TABLE parts ENABLE TRIGGER trg_parts_search_vec`;
  console.log("Search vectors rebuilt.");

  // Final stats
  const [finalRow] = await sql`SELECT COUNT(*) AS cnt FROM parts`;
  const finalCount = Number(finalRow?.cnt ?? 0);
  const newParts = finalCount - existingCount;

  console.log("\n=== JLCPCB API Ingestion Complete ===");
  console.log(`  Categories processed: ${progress.completedCategories.length}`);
  console.log(`  Parts fetched from API: ${progress.totalFetched.toLocaleString()}`);
  console.log(`  Parts before: ${existingCount.toLocaleString()}`);
  console.log(`  Parts after:  ${finalCount.toLocaleString()}`);
  console.log(`  New parts added: ${newParts.toLocaleString()}`);
  console.log(
    `  Duration: ${((Date.now() - new Date(progress.startedAt).getTime()) / 1000 / 60).toFixed(1)} minutes`,
  );

  require("fs").unlinkSync(PROGRESS_FILE);
  await sql.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
