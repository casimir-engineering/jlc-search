/**
 * Shared types, constants, and functions for JLCPCB API ingestion.
 * Used by download-jlcpcb.ts, download-lcsc.ts, and process-jlcpcb.ts.
 */
import { translateChinese } from "./chinese-dict.ts";
import { buildSearchText, inferMountingType, inferPackageAliases, inferArchitectureKeywords } from "./attrs.ts";
import type { PartRow, QueryParams } from "./types.ts";

// ── Constants ──

export const API_URL =
  "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList";
export const PAGE_SIZE = 100;
export const MAX_PAGES = 1000;
export const MAX_FETCHABLE = MAX_PAGES * PAGE_SIZE; // 100,000
export const DELAY_MS = 300; // initial delay, overridden by adaptive pacer
export const BATCH_SIZE = 1000;

/**
 * Adaptive delay pacer — TCP-like AIMD (Additive Increase, Multiplicative Decrease).
 * Starts at initialMs, decreases on success, increases on rate limit/error.
 */
export class AdaptivePacer {
  private delay: number;
  private readonly min: number;
  private readonly max: number;
  private successStreak = 0;

  constructor(initialMs = 200, minMs = 50, maxMs = 5000) {
    this.delay = initialMs;
    this.min = minMs;
    this.max = maxMs;
  }

  /** Call after a successful request. Gradually speeds up. */
  onSuccess(): void {
    this.successStreak++;
    // Decrease by 10ms every 5 successes (additive increase of speed)
    if (this.successStreak % 5 === 0) {
      this.delay = Math.max(this.min, this.delay - 10);
    }
  }

  /** Call after a rate limit (429) or server error (5xx). Backs off hard. */
  onRateLimit(): void {
    this.successStreak = 0;
    this.delay = Math.min(this.max, this.delay * 2); // multiplicative decrease of speed
  }

  /** Call after a timeout or network error. Moderate backoff. */
  onTimeout(): void {
    this.successStreak = 0;
    this.delay = Math.min(this.max, Math.floor(this.delay * 1.5));
  }

  /** Wait the current delay. */
  async wait(): Promise<void> {
    await Bun.sleep(this.delay);
  }

  /** Current delay in ms. */
  get currentDelay(): number {
    return this.delay;
  }
}

export const LCSC_API = "https://wmsc.lcsc.com/ftps/wm/product/detail";
export const LCSC_CONCURRENCY = 5;
export const LCSC_DELAY_MS = 100;

export const CATEGORIES = [
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

export interface JlcPart {
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
  minPurchaseNum?: number;
  attributes?: Record<string, unknown>;
  componentProductType?: number;
}

export interface ApiQuery {
  key: string;
  label: string;
  params: QueryParams;
}

// ── API fetch ──

export async function fetchPage(
  params: QueryParams,
  page: number,
  pacer?: AdaptivePacer,
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
        if (resp.status === 429 || resp.status >= 500) {
          pacer?.onRateLimit();
          console.error(`  HTTP ${resp.status} for page ${page}, backing off to ${pacer?.currentDelay ?? 2000}ms...`);
        } else {
          console.error(`  HTTP ${resp.status} for page ${page}, retrying...`);
        }
        await Bun.sleep(pacer?.currentDelay ?? 2000 * (attempt + 1));
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

      pacer?.onSuccess();
      return {
        parts: data.data.componentPageInfo.list,
        total: data.data.componentPageInfo.total,
      };
    } catch (err) {
      pacer?.onTimeout();
      console.error(`  Fetch error for page ${page}: ${err}, retrying (delay=${pacer?.currentDelay ?? '?'}ms)...`);
      await Bun.sleep(pacer?.currentDelay ?? 2000 * (attempt + 1));
    }
  }
  return null;
}

export async function fetchTotal(params: QueryParams): Promise<number> {
  const result = await fetchPage(params, 1);
  await Bun.sleep(DELAY_MS);
  return result?.total ?? 0;
}

// ── Subcategory discovery ──

export async function discoverSubcategories(category: string): Promise<string[]> {
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

export function buildQueryKey(params: QueryParams): string {
  const parts: string[] = [params.firstSortName];
  if (params.secondSortName) parts.push(params.secondSortName);
  if (params.stockFlag === 1) parts.push("instock");
  if (params.componentLibraryType) parts.push(params.componentLibraryType);
  return parts.join(" > ");
}

export async function buildWorkQueue(opts: {
  categoryFilter?: string[] | null;
  instockOnly?: boolean;
}): Promise<ApiQuery[]> {
  const queue: ApiQuery[] = [];
  const categoriesToProcess = opts.categoryFilter ?? CATEGORIES;

  for (const category of categoriesToProcess) {
    const baseStock: Pick<QueryParams, "stockFlag"> = opts.instockOnly ? { stockFlag: 1 } : {};

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

      if (opts.instockOnly) {
        queue.push({
          key: buildQueryKey(subParams),
          label: `${category} > ${sub} [capped at 100k of ${subTotal.toLocaleString()}]`,
          params: subParams,
        });
        console.log(`  ${sub}: ${subTotal.toLocaleString()} — capped at 100k (instock-only)`);
        continue;
      }

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

export function mapPartType(libraryType: string): string {
  switch (libraryType) {
    case "base": return "Basic";
    case "preferred": return "Preferred";
    default: return "Extended";
  }
}

export function formatPrices(
  prices: { startNumber: number; endNumber: number; productPrice: number }[],
): string {
  if (!prices || prices.length === 0) return "";
  return prices
    .sort((a, b) => a.startNumber - b.startNumber)
    .map((p) => `${p.startNumber}-${p.endNumber > 0 ? p.endNumber : ""}:${p.productPrice}`)
    .join(",");
}

export function convertPart(p: JlcPart): PartRow {
  const lcsc = (p.componentCode || "").toUpperCase();
  const partType = mapPartType(p.componentLibraryType);
  const pcbaType = p.componentProductType === 2 ? "Standard" : "Economic+Standard";
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
    joints: null,
    moq: p.minPurchaseNum ?? null,
    stock: p.stockCount || 0,
    jlc_stock: p.stockCount || 0,
    price_raw: formatPrices(p.componentPrices || []),
    img: p.minImage || p.componentImageUrl || null,
    url: p.urlSuffix || null,
    part_type: partType,
    pcba_type: pcbaType,
    attributes: attrsJson,
    search_text: [buildSearchText(attrsJson), inferMountingType(translateChinese(p.componentSpecificationEn || "") || null, attrsJson), inferPackageAliases(translateChinese(p.componentSpecificationEn || "") || null), inferArchitectureKeywords(translateChinese(p.componentModelEn || ""))].filter(Boolean).join(" "),
  };
}

// ── CLI flag parsing helpers ──

export function parseCategoryFilter(argv: string[]): string[] | null {
  const idx = argv.indexOf("--categories");
  if (idx === -1 || !argv[idx + 1]) return null;
  const raw = argv[idx + 1];
  return raw.split(raw.includes("|") ? "|" : ",").map(s => s.trim()).filter(s => s.length > 0);
}
