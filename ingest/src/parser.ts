import type { PartRow } from "./types.ts";
import { buildSearchText } from "./attrs.ts";
import { translateChinese } from "./chinese-dict.ts";

/**
 * Actual attribute structure in jlcparts JSON:
 * "Key": { "format": "...", "primary": "fieldname", "values": { "fieldname": [value, type] } }
 * So to get the value: attrs[key].values[attrs[key].primary][0]
 */
interface AttrEntry {
  format?: string;
  primary?: string;
  values?: Record<string, [unknown, string]>;
}

function getAttrValue(attrs: Record<string, unknown>, key: string): string | null {
  const entry = attrs[key];
  if (!entry) return null;

  // New nested format: { primary, values: { [primary]: [value, type] } }
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const e = entry as AttrEntry;
    if (e.primary && e.values) {
      const val = e.values[e.primary];
      if (Array.isArray(val) && val.length > 0 && val[0] != null) {
        return String(val[0]);
      }
    }
    return null;
  }

  // Legacy flat string format
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);

  return null;
}

/** Normalize price to string format "1-9:0.005,10-99:0.004,..." */
function normalizePriceToString(price: unknown): string {
  if (!price) return "";
  if (typeof price === "string") return price;
  if (Array.isArray(price)) {
    return (price as Array<{ qFrom?: number; qTo?: number | null; price?: number; unitPrice?: number }>)
      .map((p) => {
        const from = p.qFrom ?? 1;
        const to = p.qTo != null ? p.qTo : "";
        const unitPrice = p.price ?? p.unitPrice ?? 0;
        return `${from}-${to}:${unitPrice}`;
      })
      .join(",");
  }
  return "";
}

/**
 * Map a jlcparts component array to our PartRow shape.
 *
 * IMPORTANT schema notes from actual data inspection:
 * - schema[1] = "mfr" contains the MPN (e.g., "AD421BRZRL7"), NOT manufacturer name
 * - schema[8] = "attributes" is a dict where each value is { primary, values: { primary: [value, type] } }
 * - attrs["Manufacturer"].values["default"][0] = manufacturer name (e.g., "Analog Devices")
 * - attrs["Basic/Extended"].values["default"][0] = part type string (e.g., "Extended")
 * - attrs["Package"].values["default"][0] = package string (e.g., "SOIC-16-300mil")
 */
export function parseComponent(
  schemaArr: string[],
  row: unknown[],
  category: string,
  subcategory: string
): PartRow {
  // Map array positions by schema field name
  const comp: Record<string, unknown> = {};
  schemaArr.forEach((key, i) => {
    comp[key] = row[i];
  });

  const attrs = (comp.attributes ?? {}) as Record<string, unknown>;

  // Extract part type
  const rawPartType = getAttrValue(attrs, "Basic/Extended") ?? "Extended";
  let partType = "Extended";
  if (/basic/i.test(rawPartType)) partType = "Basic";
  else if (/preferred/i.test(rawPartType)) partType = "Preferred";
  else if (/mechanical/i.test(rawPartType)) partType = "Mechanical";

  const pcbaType =
    partType === "Extended" || partType === "Mechanical"
      ? "Standard"
      : "Economic+Standard";

  const manufacturer = getAttrValue(attrs, "Manufacturer");
  const pkg = getAttrValue(attrs, "Package");

  // Normalize LCSC code
  let lcsc = String(comp.lcsc ?? "");
  if (lcsc && !/^C/i.test(lcsc)) lcsc = `C${lcsc}`;
  lcsc = lcsc.toUpperCase();

  // "mfr" in schema = MPN (counterintuitive)
  const mpn = translateChinese(String(comp.mfr ?? ""));

  return {
    lcsc,
    mpn,
    manufacturer,
    category,
    subcategory,
    description: String(comp.description ?? ""),
    datasheet: typeof comp.datasheet === "string" && comp.datasheet ? comp.datasheet : null,
    package: translateChinese(pkg ?? "") || null,
    joints: comp.joints != null ? Number(comp.joints) : null,
    stock: 0,
    price_raw: normalizePriceToString(comp.price),
    img: typeof comp.img === "string" && comp.img ? comp.img : null,
    url: typeof comp.url === "string" && comp.url ? comp.url : null,
    part_type: partType,
    pcba_type: pcbaType,
    attributes: JSON.stringify(attrs),
    search_text: buildSearchText(JSON.stringify(attrs)),
  };
}
