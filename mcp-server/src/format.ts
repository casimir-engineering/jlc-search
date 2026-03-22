import type { PartSummary } from "../../backend/src/types.ts";

/**
 * Parse price_raw and format as readable pricing tiers.
 * Input: "1-10:0.0052,11-50:0.0048,51-100:0.004"
 * Output: "1+: $0.0052/ea | 11+: $0.0048/ea | 51+: $0.004/ea"
 */
export function formatPriceTiers(priceRaw: string): string {
  if (!priceRaw || priceRaw.trim() === "") return "N/A";

  const tiers = priceRaw.split(",").map((tier) => {
    const [range, price] = tier.split(":");
    if (!range || !price) return null;
    const startQty = range.split("-")[0];
    return `${startQty}+: $${price}/ea`;
  });

  const valid = tiers.filter(Boolean) as string[];
  return valid.length > 0 ? valid.join(" | ") : "N/A";
}

/**
 * Format a number with comma separators.
 */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Get the first (lowest quantity) unit price from price_raw.
 */
function getUnitPrice(priceRaw: string): string {
  if (!priceRaw || priceRaw.trim() === "") return "N/A";
  const first = priceRaw.split(",")[0];
  if (!first) return "N/A";
  const price = first.split(":")[1];
  return price ? `$${price}/ea` : "N/A";
}

/**
 * Format stock number in compact form (e.g. 2,847,000 -> "2.8M", 15,000 -> "15K").
 */
function compactStock(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/**
 * Format attributes into a readable string.
 * Handles both object ({key: value}) and array ([{key, value}]) formats.
 */
function formatAttributes(attrs: unknown): string {
  if (!attrs || typeof attrs !== "object") return "";
  if (Array.isArray(attrs)) {
    // Array of {key, value} or {name, value} objects
    const pairs = attrs
      .filter((a): a is Record<string, unknown> => a && typeof a === "object")
      .map((a) => {
        const key = (a.key ?? a.name ?? "") as string;
        const val = (a.value ?? "") as string;
        return key && val ? `${key}=${val}` : null;
      })
      .filter(Boolean);
    return pairs.join(", ");
  }
  // Plain object
  const entries = Object.entries(attrs as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries
    .filter(([, v]) => v != null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/**
 * Truncate a string to maxLen characters, adding "..." if truncated.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

/**
 * Format a single part as a readable text block.
 */
export function formatPart(part: PartSummary, index?: number): string {
  const lines: string[] = [];

  // Header line: index, LCSC, manufacturer, MPN
  const prefix = index != null ? `${index}. ` : "";
  const mfr = part.manufacturer ? `${part.manufacturer} ` : "";
  lines.push(`${prefix}${part.lcsc} — ${mfr}${part.mpn}`);

  // Description
  const indent = index != null ? "   " : "";
  lines.push(`${indent}${part.description}`);

  // Category
  lines.push(
    `${indent}Category: ${part.category}${part.subcategory ? ` > ${part.subcategory}` : ""}`
  );

  // Package, Type, PCBA
  const pkgParts: string[] = [];
  if (part.package) pkgParts.push(`Package: ${part.package}`);
  pkgParts.push(`Type: ${part.part_type}`);
  pkgParts.push(`PCBA: ${part.pcba_type}`);
  lines.push(`${indent}${pkgParts.join(" | ")}`);

  // Stock
  lines.push(
    `${indent}Stock: JLCPCB ${formatNumber(part.jlc_stock)} | LCSC ${formatNumber(part.stock)}`
  );

  // Price
  lines.push(`${indent}Price: ${formatPriceTiers(part.price_raw)}`);

  // Attributes
  if (part.attributes) {
    const attrs = formatAttributes(part.attributes);
    if (attrs) lines.push(`${indent}Attributes: ${attrs}`);
  }

  // Datasheet
  if (part.datasheet) {
    lines.push(`${indent}Datasheet: ${part.datasheet}`);
  }

  // Product page
  if (part.url) {
    lines.push(`${indent}Product page: ${part.url}`);
  }

  return lines.join("\n");
}

/**
 * Single-line compact format for comparison tables.
 * "C1525 | Samsung CL05B104KO5NNNC | 100nF 50V X7R 0402 | Basic | JLCPCB: 2.8M | $0.0018/ea"
 */
export function formatPartCompact(part: PartSummary): string {
  const mfr = part.manufacturer ? `${part.manufacturer} ` : "";
  const parts = [
    part.lcsc,
    `${mfr}${part.mpn}`,
    part.description,
    part.part_type,
    `JLCPCB: ${compactStock(part.jlc_stock)}`,
    getUnitPrice(part.price_raw),
  ];
  return parts.join(" | ");
}

/**
 * Format full search results with header and numbered parts.
 */
export function formatSearchResults(
  results: PartSummary[],
  total: number,
  tookMs: number,
  query: string
): string {
  const lines: string[] = [];

  lines.push(`Found ${formatNumber(total)} parts matching "${query}" (${tookMs}ms)`);
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    lines.push(formatPart(results[i], i + 1));
    if (i < results.length - 1) lines.push("");
  }

  return lines.join("\n");
}

/**
 * Side-by-side comparison as aligned text table.
 */
export function formatComparisonTable(parts: PartSummary[]): string {
  if (parts.length === 0) return "No parts to compare.";

  const lines: string[] = [];
  lines.push(`Comparing ${parts.length} parts:`);
  lines.push("");

  const MAX_COL = 30; // max column width for readability

  // Define rows to display
  const rows: { label: string; getValue: (p: PartSummary) => string }[] = [
    { label: "MPN", getValue: (p) => truncate(p.mpn, MAX_COL) },
    { label: "Manufacturer", getValue: (p) => truncate(p.manufacturer || "—", MAX_COL) },
    { label: "Description", getValue: (p) => truncate(p.description, MAX_COL) },
    { label: "Package", getValue: (p) => p.package || "—" },
    { label: "Type", getValue: (p) => p.part_type },
    { label: "PCBA", getValue: (p) => p.pcba_type },
    { label: "JLCPCB Stock", getValue: (p) => formatNumber(p.jlc_stock) },
    { label: "LCSC Stock", getValue: (p) => formatNumber(p.stock) },
    { label: "Unit Price", getValue: (p) => getUnitPrice(p.price_raw) },
    { label: "Datasheet", getValue: (p) => p.datasheet ? "Yes" : "—" },
  ];

  // Calculate column widths (capped at MAX_COL)
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const colWidths = parts.map((p) => {
    const headerLen = p.lcsc.length;
    const valueLen = Math.max(...rows.map((r) => r.getValue(p).length));
    return Math.min(MAX_COL, Math.max(headerLen, valueLen));
  });

  // Pad helper
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

  // Header row with LCSC numbers
  const headerCells = parts.map((p, i) => pad(p.lcsc, colWidths[i]));
  lines.push(`${pad("", labelWidth)} | ${headerCells.join(" | ")}`);

  // Separator
  const sepCells = colWidths.map((w) => "-".repeat(w));
  lines.push(`${"-".repeat(labelWidth)}-+-${sepCells.join("-+-")}`);

  // Data rows
  for (const row of rows) {
    const cells = parts.map((p, i) => pad(truncate(row.getValue(p), colWidths[i]), colWidths[i]));
    lines.push(`${pad(row.label, labelWidth)} | ${cells.join(" | ")}`);
  }

  return lines.join("\n");
}
