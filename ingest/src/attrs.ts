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

const SI_MULTIPLIERS: Record<string, number> = {
  G: 1e9, M: 1e6, k: 1e3,
  m: 1e-3, u: 1e-6, μ: 1e-6, n: 1e-9, p: 1e-12,
};

/** Unit suffixes we recognize when parsing strings like "20mA", "100nF", "50V" */
const STRING_UNIT_SUFFIXES: [RegExp, string][] = [
  [/(?:Ohm|Ω|Ω)$/i, "Ohm"],
  [/Hz$/, "Hz"],
  [/V$/, "V"],
  [/F$/, "F"],
  [/A$/, "A"],
  [/H$/, "H"],
  [/W$/, "W"],
];

/**
 * Parse a string like "20mA", "100nF", "4.7kOhm", "50V" into {value, unit}.
 * Returns null if the string doesn't match a recognized SI+unit pattern.
 */
function parseStringValue(s: string): { value: number; unit: string } | null {
  // Try each unit suffix
  for (const [re, unit] of STRING_UNIT_SUFFIXES) {
    const match = s.match(re);
    if (!match) continue;

    // Strip the unit suffix to get the numeric+prefix part
    const numPart = s.slice(0, match.index);
    // Match: optional negative, digits, optional decimal, optional SI prefix
    const numMatch = numPart.match(/^(-?\d+\.?\d*)(G|M|k|m|u|μ|n|p)?$/);
    if (!numMatch) continue;

    const num = parseFloat(numMatch[1]);
    if (!isFinite(num)) continue;
    const mult = numMatch[2] ? (SI_MULTIPLIERS[numMatch[2]] ?? 1) : 1;
    return { value: num * mult, unit };
  }
  return null;
}

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
/**
 * Extract numeric values with SI units from a free-text string (e.g. description).
 * Finds patterns like "100mW", "3.4V", "30mA", "100nF" embedded in text.
 */
export function extractNumericFromText(text: string): NumericAttr[] {
  if (!text) return [];
  const results: NumericAttr[] = [];
  const seen = new Set<string>();
  // Match number + optional SI prefix + unit suffix, with word boundaries
  const re = /(?<!\w)(-?\d+\.?\d*)(G|M|k|m|u|μ|n|p)?(V|Ohm|Ω|Ω|Hz|F|A|H|W)(?!\w)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseFloat(m[1]);
    if (!isFinite(num)) continue;
    const mult = m[2] ? (SI_MULTIPLIERS[m[2]] ?? 1) : 1;
    const value = num * mult;
    const unit = (m[3] === "Ω" || m[3] === "Ω") ? "Ohm" : m[3];
    const k = `${unit}:${value}`;
    if (!seen.has(k)) { results.push({ unit, value }); seen.add(k); }
  }
  return results;
}

export function extractNumericAttrs(attrsJson: string, description?: string): NumericAttr[] {
  let attrs: Record<string, unknown>;
  try {
    attrs = JSON.parse(attrsJson);
  } catch {
    return [];
  }

  const results: NumericAttr[] = [];
  const seen = new Set<string>(); // dedupe by "unit:value"

  for (const [key, raw] of Object.entries(attrs)) {
    if (SKIP_KEYS.has(key)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;

    const entry = raw as AttrEntry;
    const extracted = extractAttrValueAndType(entry);
    if (!extracted) continue;

    // Path 1: Numeric value with typed unit (e.g. value=0.02, type="current")
    const typeLower = extracted.type.toLowerCase();
    const unit = TYPE_UNITS[typeLower];
    if (unit && typeof extracted.value === "number" && isFinite(extracted.value)) {
      const k = `${unit}:${extracted.value}`;
      if (!seen.has(k)) { results.push({ unit, value: extracted.value }); seen.add(k); }
      continue;
    }

    // Path 2: String value with embedded SI unit (e.g. "20mA", "100nF", "50V")
    if (typeof extracted.value === "string") {
      const parsed = parseStringValue(extracted.value.trim());
      if (parsed) {
        const k = `${parsed.unit}:${parsed.value}`;
        if (!seen.has(k)) { results.push(parsed); seen.add(k); }
      }
    }
  }

  // Path 3: Extract from description text (catches values not in structured attributes)
  if (description) {
    for (const { unit, value } of extractNumericFromText(description)) {
      const k = `${unit}:${value}`;
      if (!seen.has(k)) { results.push({ unit, value }); seen.add(k); }
    }
  }

  return results;
}

// ── Mounting type inference ──────────────────────────────────────────

/** SMD package patterns — derived from 446k+ parts in the JLCPCB/LCSC database */
const SMD_PATTERNS: RegExp[] = [
  /^\d{4}([x×(,\s_-]|$)/,              // Chip sizes: 0201, 0402, 0603, 0805, 1206, 2512, etc.
  /^01005$/,                             // Smallest chip size
  /^SMD/i,                               // Explicit SMD prefix
  /^SMT([,\s_-]|$)/i,                   // Explicit SMT prefix
  /^SOIC|^SO-?\d/,                       // SOIC-8, SO-8
  /SOP|SSOP|TSSOP|MSOP|QSOP|ESOP|HSOP|VSSOP|HTSSOP/i, // SOP family
  /^DSO[FNP]?-?\d/,                     // DSO packages
  /^SOT-?\d/,                           // SOT-23, SOT-89, SOT-223, SOT-363, etc.
  /^[TS]SOT/,                           // TSOT, SSOT variants
  /^SC-?\d\d/,                          // SC-70, SC-88, SC-59
  /^SOD-?\d/,                           // SOD-123, SOD-323, SOD-523
  /QFP/i,                               // QFP/LQFP/TQFP/PQFP/VQFP/UFQFPN...
  /QFN|DFN/i,                           // QFN/DFN/WQFN/TDFN/VSON/WSON/PDFN/UDFN...
  /BGA|WLCSP|WLP-?\d|CSP-?\d|DSBGA/i,  // BGA family + wafer-level
  /^LGA-?\d/,                           // LGA
  /^PLCC/,                              // PLCC
  /^CLCC|^LCC([,\s_(-]|$)/,            // CLCC, LCC
  /^TSOP/,                              // TSOP
  /^CERPACK/,                           // Ceramic flat pack
  /^SM[ABC][FGJCE]?([,\s_(-]|$)/,      // SMA, SMB, SMC diode packages
  /^DO-?2[1-2]\d/,                      // DO-213 through DO-221 (SMD diode)
  /^MELF|MiniMELF|QuadroMELF/i,        // MELF packages
  /^LL-?[34]\d/,                        // LL-34, LL-41 (MELF variants)
  /D[23]?PAK|DPAK|DDPAK|ATPAK/i,       // DPAK family
  /^TO-?252|^TO-?263|^TO-?277/,         // SMD TO packages
  /^TO-?236|^TO-?243|^TO-?261/,         // SOT aliases
  /^TOLL([,\s_-]|$)/i,                  // TOLL power package
  /^HC-?49S?-?SMD|^HC-?49US|^HC-?49SM|^MA-?406|^OSC-?SMD/i, // Crystal SMD
  /^[RCBA]\d{4}([,\s_-]|$)/,           // Prefixed chips: R0402, C0805
  /^CASE-?[A-Z]/i,                      // Tantalum CASE codes
  /^LED\d{3,4}/,                        // LED0603, LED0805
  /CONN-?SMD|LED-?SMD|FPC-?SMD|FFC-?SMD|SW-?SMD/i, // Component-type SMD
  /PowerPAK|PowerDI|TDSON/i,            // Power SMD packages
  /^USP[CNEL]?-?\d/i,                   // USP family
  /^SOJ/,                               // SOJ (small outline J-lead)
  /^CFP-?\d/,                           // Ceramic flat pack
  /^XFLGA/,                             // XFLGA
];

/** THT package patterns — derived from 446k+ parts in the JLCPCB/LCSC database */
const THT_PATTERNS: RegExp[] = [
  /^DIP([-_ ,(\d]|$)|^PDIP|^SDIP|^CDIP|^CERDIP|^SPDIP/i, // DIP family
  /^SIP[-_ ,\d(]|^SIP$/i,               // SIP modules
  /^Plugin/i,                            // Plugin (very common in JLCPCB)
  /Through.?[Hh]ol/i,                   // Through-hole explicit
  /^TH-?\d+P|^TH([,\s_-]|$)/,          // TH-2P, TH-4P
  /^TO-?220(?!.*SMD)|^ITO-?220/,        // TO-220 (not SMD variant)
  /^TO-?92/,                            // TO-92
  /^TO-?247/,                           // TO-247
  /^TO-?3([P\s,(-]|$)/,                // TO-3, TO-3P
  /^TO-?126/,                           // TO-126
  /^TO-?251|^IPAK([,\s(-]|$)/,         // TO-251 / IPAK
  /^TO-?262|^I2PAK/,                    // TO-262 / I2PAK
  /^TO-?264|^TO-?268|^TO-?270|^TO-?274|^TO-?275/,  // Large TO packages
  /^TO-?218/,                           // TO-218
  /^TO-?39|^TO-?46|^TO-?18|^TO-?99|^TO-?66|^TO-?48/,  // TO-can packages
  /^TO-?5([,\s_(-]|$)|^TO-?56|^TO-?202|^TO-?225/,     // TO-5 etc.
  /^TO-?CAN/i,                          // TO-CAN
  /^DO-?35|^DO-?41|^DO-?15([,\s_(-]|$)|^DO-?27/,  // Axial diodes
  /^DO-?20[0-9]/,                       // DO-201, DO-204
  /^DO-?7([,\s_(-]|$)|^DO-?[45]([,\s_(-]|$)/,  // Stud-mount
  /^DO-?13([,\s_(-]|$)|^DO-?247/,      // DO-13, DO-247
  /^GB[UJP]|^KB[UPS]|^MBS|^DBS/i,      // Bridge rectifiers
  /^P600/,                              // P600 power diode
  /^R-?6([^0-9]|$)/,                   // R-6 diode
  /^Axial/i,                            // Axial
  /^Bolt/i,                             // Bolt mount
  /^HC-?49U|^HC-?49S?([,\s_-]|$)(?!.*SMD)/i,  // Crystal THT
  /^DT-?\d/,                            // DT crystal packages
  /^ZIP/,                               // ZIP package
  /^PGA/,                               // PGA
  /CONN-?TH|HDR-?TH/i,                 // Component-type THT
  /^Straight/i,                         // Straight connectors
];

/**
 * Infer mounting type from package name and attributes.
 * Returns searchable keywords: "SMD SMT surface-mount" or "THT TH through-hole" or "".
 */
export function inferMountingType(pkg: string | null, attrsJson: string): string {
  // Check attributes for explicit mounting type (highest confidence)
  if (/Surface\s*Mount|Reverse\s*Mount|Top-mount|Side View Mount/i.test(attrsJson)) return "SMD SMT surface-mount";
  if (/Through[\s-]*[Hh]ole/i.test(attrsJson)) return "THT TH through-hole";

  // Infer from package name
  if (!pkg) return "";
  const trimmed = pkg.trim();
  if (!trimmed || trimmed === "-") return "";

  for (const re of SMD_PATTERNS) {
    if (re.test(trimmed)) return "SMD SMT surface-mount";
  }
  for (const re of THT_PATTERNS) {
    if (re.test(trimmed)) return "THT TH through-hole";
  }

  return "";
}

/** WLCSP-family package patterns for alias keyword injection */
const WLCSP_PATTERNS: RegExp[] = [
  /WLCSP|WL-CSP|WCSP/i,
  /DSBGA/i,
  /WLBGA/i,
  /\bCSP-?\d/i,       // CSP-9, CSP-16
  /\bWLP-?\d/i,       // WLP-4
  /fcCSP/i,
  /\bUCSP/i,
  /MicroSMD/i,
  /NanoFree/i,
  /\bLFCSP/i,         // LFCSP (Analog Devices variant)
];

const WLCSP_KEYWORDS = "WLCSP WL-CSP WCSP WLBGA DSBGA fcCSP UCSP MicroSMD NanoFree FI-WLP CSP WLP";

/**
 * Infer package alias keywords from package name.
 * Returns searchable keywords for WLCSP-family packages, or "".
 */
export function inferPackageAliases(pkg: string | null): string {
  if (!pkg) return "";
  const trimmed = pkg.trim();
  if (!trimmed || trimmed === "-") return "";
  for (const re of WLCSP_PATTERNS) {
    if (re.test(trimmed)) return WLCSP_KEYWORDS;
  }
  return "";
}

// ── Architecture keyword inference (MPN-based) ──────────────────────

/** RISC-V MPN patterns — matched against the part's MPN to inject architecture keywords */
const RISCV_MPN_PATTERNS: RegExp[] = [
  // WCH (Qingke RISC-V cores)
  /^CH32[VXLM]/i,          // CH32V003, CH32X035, CH32L103, CH32M030
  /^CH6[4][1-9]/i,         // CH641, CH643, CH645
  /^CH56[5-9]/i,           // CH565, CH569
  /^CH57[0-3]/i,           // CH571, CH573
  /^CH58[1-5]/i,           // CH581-CH585
  /^CH59[1-2]/i,           // CH591, CH592

  // Espressif (RISC-V variants only — NOT ESP32, ESP32-S2, ESP32-S3 which are Xtensa)
  /^ESP32-?C[2-6]/i,       // ESP32-C2, ESP32-C3, ESP32-C5, ESP32-C6, ESP32-C61
  /^ESP32-?H\d/i,          // ESP32-H2, ESP32-H4
  /^ESP32-?P\d/i,          // ESP32-P4
  /^ESP8684/i,             // Rebadged ESP32-C2
  /^ESP8685/i,             // Rebadged ESP32-C2

  // GigaDevice (RISC-V variants)
  /^GD32VF/i,              // GD32VF103
  /^GD32VW/i,              // GD32VW553
  /^GD32A5/i,              // GD32A503/A508 (Nuclei N300 RISC-V)

  // Bouffalo Lab
  /^BL60[2-6]/i,           // BL602, BL604, BL606
  /^BL61[6-8]/i,           // BL616, BL618
  /^BL70[2-6]/i,           // BL702, BL704, BL706
  /^BL808/i,               // BL808 triple-core

  // HPMicro (all are RISC-V)
  /^HPM[56]/i,             // HPM5xxx, HPM6xxx

  // Raspberry Pi (dual-arch ARM + RISC-V)
  /^RP235[04]/i,           // RP2350, RP2354

  // Canaan/Kendryte
  /^K210/i,                // K210 AI SoC
  /^K230/i,                // K230, K230D
  /^K510/i,                // K510

  // Allwinner (pure RISC-V SoCs)
  /^D1-?[HhSs]/i,         // D1-H, D1s
  /^F133/i,                // F133 (same silicon as D1s)

  // Telink (only TLSR9xxx is RISC-V; TLSR8xxx is proprietary)
  /^TLSR9/i,               // TLSR9211, TLSR9518, etc.

  // Beken (RISC-V variants)
  /^BK723[5-7]/i,          // BK7235, BK7236, BK7237
  /^BK7256/i,              // BK7256

  // Sophgo/CVITEK
  /^SG200/i,               // SG2000, SG2002
  /^CV18/i,                // CV1800, CV1811, CV1812, CV1835, CV1838

  // T-Head (Alibaba XuanTie)
  /^TH1520/i,              // TH1520

  // SiFive
  /^FE310/i,               // FE310-G002

  // Nations Technologies
  /^N32G4FR/i,             // N32G4FR RISC-V MCU

  // Puya (only C6 series is RISC-V)
  /^PY32C6/i,              // PY32C6xx
];

const RISCV_KEYWORDS = "RISC-V RISCV risc-v riscv risc-5 risc5";

/**
 * Infer architecture keywords from MPN.
 * Returns searchable keywords for RISC-V parts, or "".
 */
export function inferArchitectureKeywords(mpn: string | null): string {
  if (!mpn) return "";
  const trimmed = mpn.trim();
  if (!trimmed) return "";
  for (const re of RISCV_MPN_PATTERNS) {
    if (re.test(trimmed)) return RISCV_KEYWORDS;
  }
  return "";
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
