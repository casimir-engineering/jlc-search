/**
 * Flatten part attributes JSON into a searchable text string.
 * Converts SI-typed numeric values to human-readable form (e.g. 1e-7 → "100nF")
 * and passes string values through as-is.
 */

interface AttrEntry {
  format?: string;
  primary?: string;
  default?: string;
  values?: Record<string, [unknown, string]>;
}

/** Keys already covered by other FTS columns — skip them */
const SKIP_KEYS = new Set(["Basic/Extended", "Manufacturer", "Package", "Status"]);

interface SIPrefix {
  threshold: number;
  divisor: number;
  prefix: string;
}

const SI_PREFIXES: SIPrefix[] = [
  { threshold: 1e9, divisor: 1e9, prefix: "G" },
  { threshold: 1e6, divisor: 1e6, prefix: "M" },
  { threshold: 1e3, divisor: 1e3, prefix: "k" },
  { threshold: 1, divisor: 1, prefix: "" },
  { threshold: 1e-3, divisor: 1e-3, prefix: "m" },
  { threshold: 1e-6, divisor: 1e-6, prefix: "u" },
  { threshold: 1e-9, divisor: 1e-9, prefix: "n" },
  { threshold: 1e-12, divisor: 1e-12, prefix: "p" },
];

/** Map from attribute type strings (as found in jlcparts data) to unit suffixes */
const TYPE_UNITS: Record<string, string> = {
  capacitance: "F",
  resistance: "Ohm",
  voltage: "V",
  current: "A",
  inductance: "H",
  power: "W",
  frequency: "Hz",
  temperature: "°C",
};

/**
 * Format a numeric value with SI prefix and unit suffix.
 * e.g. formatSI(1e-7, "F") → "100nF", formatSI(10000, "Ohm") → "10kOhm"
 */
function formatSI(value: number, unit: string): string {
  if (value === 0) return `0${unit}`;

  const abs = Math.abs(value);

  for (const { threshold, divisor, prefix } of SI_PREFIXES) {
    if (abs >= threshold * 0.999) {
      const scaled = value / divisor;
      // Use toPrecision to avoid floating point noise, then strip trailing zeros
      const formatted = Number(scaled.toPrecision(4));
      return `${formatted}${prefix}${unit}`;
    }
  }

  // Smaller than pico — just use raw number
  return `${value}${unit}`;
}

/**
 * Extract value and type from an attribute entry.
 * Checks both `primary` and `default` pointers since some attributes use one or the other.
 */
function extractAttrValueAndType(entry: AttrEntry): { value: unknown; type: string } | null {
  if (!entry.values) return null;

  // Try primary pointer first, then default
  const pointer = entry.primary ?? entry.default;
  if (pointer && entry.values[pointer]) {
    const [value, type] = entry.values[pointer];
    if (value != null) return { value, type: type ?? "" };
  }

  // Try "default" key directly if no pointer worked
  if (entry.values["default"]) {
    const [value, type] = entry.values["default"];
    if (value != null) return { value, type: type ?? "" };
  }

  return null;
}

/**
 * Convert a single attribute value to a search-friendly string.
 * Returns null if the value is empty or not useful for search.
 */
function formatAttrValue(value: unknown, type: string): string | null {
  const typeLower = type.toLowerCase();
  const unit = TYPE_UNITS[typeLower];

  // Numeric SI value with known unit
  if (unit && typeof value === "number" && isFinite(value)) {
    return formatSI(value, unit);
  }

  // String value — pass through if non-empty
  const str = String(value).trim();
  if (str === "" || str === "-" || str === "null" || str === "undefined") return null;

  return str;
}

/**
 * Build a searchable text string from the attributes JSON blob.
 * Returns space-separated tokens suitable for FTS5 indexing.
 */
export interface NumericAttr {
  unit: string;  // V, Ohm, F, A, H, W, Hz
  value: number;
}

/**
 * Extract numeric attribute values with their units from attributes JSON.
 * Used to populate the part_nums table for range filtering.
 */
export function extractNumericAttrs(attrsJson: string): NumericAttr[] {
  let attrs: Record<string, unknown>;
  try {
    attrs = JSON.parse(attrsJson);
  } catch {
    return [];
  }

  const results: NumericAttr[] = [];

  for (const [key, raw] of Object.entries(attrs)) {
    if (SKIP_KEYS.has(key)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;

    const entry = raw as AttrEntry;
    const extracted = extractAttrValueAndType(entry);
    if (!extracted) continue;

    const typeLower = extracted.type.toLowerCase();
    const unit = TYPE_UNITS[typeLower];
    if (unit && typeof extracted.value === "number" && isFinite(extracted.value)) {
      results.push({ unit, value: extracted.value });
    }
  }

  return results;
}

/**
 * Build a searchable text string from the attributes JSON blob.
 * Returns space-separated tokens suitable for FTS5 indexing.
 */
export function buildSearchText(attrsJson: string): string {
  let attrs: Record<string, unknown>;
  try {
    attrs = JSON.parse(attrsJson);
  } catch {
    return "";
  }

  const parts: string[] = [];

  for (const [key, raw] of Object.entries(attrs)) {
    if (SKIP_KEYS.has(key)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;

    const entry = raw as AttrEntry;
    const extracted = extractAttrValueAndType(entry);
    if (!extracted) continue;

    const formatted = formatAttrValue(extracted.value, extracted.type);
    if (formatted) parts.push(formatted);
  }

  return parts.join(" ");
}
