/**
 * Generic component-aware text processing module.
 * Extracts structured properties and keywords from arbitrary text.
 * Works with text from any source: datasheets, descriptions, API attributes.
 *
 * Category determines which extractors run. All extractors are regex-based.
 * Includes table-aware extraction for pdftotext -layout output where headers
 * and values appear on separate lines.
 */
import { extractNumericFromText } from "./attrs.ts";
import type { ExtractedProperty, ExtractionResult } from "./types.ts";

// ── Helpers ──

function findNumberNear(line: string, colStart: number, colEnd: number): number | null {
  const region = line.substring(Math.max(0, colStart - 5), Math.min(line.length, colEnd + 15));
  const m = region.match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

function scanTable(
  text: string,
  headerKeywords: { pattern: RegExp; key: string; unit: string; multiplier?: number }[],
  source: string,
): ExtractedProperty[] {
  const lines = text.split("\n");
  const props: ExtractedProperty[] = [];
  for (let i = 0; i < lines.length; i++) {
    const found: { key: string; unit: string; col: number; multiplier: number }[] = [];
    const headerEnd = Math.min(i + 4, lines.length);
    for (let h = i; h < headerEnd; h++) {
      for (const kw of headerKeywords) {
        if (found.some((f) => f.key === kw.key)) continue;
        const m = lines[h].match(kw.pattern);
        if (m && m.index !== undefined) {
          found.push({ key: kw.key, unit: kw.unit, col: m.index, multiplier: kw.multiplier ?? 1 });
        }
      }
    }
    if (found.length < 2) continue;
    for (let j = headerEnd; j < Math.min(i + 25, lines.length); j++) {
      const dataLine = lines[j];
      const nums = [...dataLine.matchAll(/\d+\.?\d*/g)];
      if (nums.length < 2) continue;
      if (/^\s*\(/.test(dataLine.trim()) && !/\d{2,}/.test(dataLine)) continue;
      for (const f of found) {
        const val = findNumberNear(dataLine, f.col, f.col + 15);
        if (val !== null && val > 0) {
          props.push({ key: f.key, value: val * f.multiplier, unit: f.unit, source });
        }
      }
      if (props.length > 0) return props;
    }
  }
  return props;
}

function scanSpecRow(
  text: string, labelRe: RegExp, valueFilter: (v: number) => boolean,
  key: string, unit: string, source: string,
): ExtractedProperty | null {
  for (const line of text.split("\n")) {
    if (!labelRe.test(line)) continue;
    for (const m of line.matchAll(/(?<!\w)(\d+\.?\d*)(?!\w*[=])/g)) {
      const val = parseFloat(m[1]);
      if (valueFilter(val)) return { key, value: val, unit, source };
    }
  }
  return null;
}

// ── Generic extractors ──

function extractGenericNumericValues(text: string, source: string, category: string): ExtractedProperty[] {
  const searchText = source === "datasheet" ? text.substring(0, 2000) : text;
  const nums = extractNumericFromText(searchText);
  const catLower = category.toLowerCase();
  return nums
    .filter((n) => {
      if (n.unit === "H" && (catLower.includes("processor") || catLower.includes("controller") ||
          catLower.includes("memory") || catLower.includes("logic") || catLower.includes("resistor"))) return false;
      return true;
    })
    .map((n) => ({ key: n.unit.toLowerCase(), value: n.value, unit: n.unit, source }));
}

function extractComplianceKeywords(text: string): string[] {
  const keywords: string[] = [];
  const patterns: [RegExp, string][] = [
    [/\bAEC-Q\d+\b/gi, ""], [/\bRoHS\b/gi, "RoHS"], [/\bREACH\b/gi, "REACH"],
    [/\bHalogen[\s-]?Free\b/gi, "Halogen-Free"], [/\bMSL[\s-]?\d\b/gi, ""],
    [/\bUL[\s-]?94\b/gi, ""], [/\bautomotive[\s-]?grade\b/gi, "automotive-grade"],
    [/\bmilitary[\s-]?grade\b/gi, "military-grade"], [/\bmedical[\s-]?grade\b/gi, "medical-grade"],
  ];
  for (const [re, fixed] of patterns) {
    const match = text.match(re);
    if (match) keywords.push(fixed || match[0]);
  }
  return keywords;
}

function extractTemperatureRange(text: string): string[] {
  const re = /(-?\d+)\s*[°˚℃]?\s*C?\s*(?:to|~|\.\.\.?)\s*[+]?(\d+)\s*[°˚℃]?\s*C/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const low = parseInt(m[1]), high = parseInt(m[2]);
    if (low >= -65 && low < 0 && high > 50 && high <= 300) return [`${low}C~${high}C`];
  }
  return [];
}

function extractFeatureKeywords(text: string): string[] {
  const keywords: string[] = [];
  const features = [
    /\blow[\s-]?ESR\b/gi, /\blow[\s-]?noise\b/gi, /\blow[\s-]?power\b/gi,
    /\bhigh[\s-]?speed\b/gi, /\bhigh[\s-]?voltage\b/gi, /\bhigh[\s-]?current\b/gi,
    /\bshielded\b/gi, /\bunshielded\b/gi, /\bwirewound\b/gi,
    /\bthin[\s-]?film\b/gi, /\bthick[\s-]?film\b/gi, /\bmetal[\s-]?film\b/gi,
    /\bsurge[\s-]?rated\b/gi, /\banti[\s-]?surge\b/gi, /\bpulse[\s-]?proof\b/gi,
    /\blow[\s-]?dropout\b/gi, /\bLDO\b/g, /\bPWM\b/g,
    /\bI2C\b/gi, /\bSPI\b/g, /\bUART\b/g, /\bUSB\b/g,
    /\bCAN\s*(?:bus|2\.0|FD)\b/gi, /\bEthernet\b/gi,
    /\bBluetooth\b/gi, /\bWiFi\b/gi, /\bLoRa\b/gi, /\bZigbee\b/gi,
    /\bADC\b/g, /\bDAC\b/g, /\bDMA\b/g, /\bJTAG\b/g, /\bSWD\b/g,
  ];
  for (const re of features) {
    const match = text.match(re);
    if (match) keywords.push(match[0].replace(/\s+/g, "-").toLowerCase());
  }
  return keywords;
}

// ── Category-specific extractors ──

function extractResistorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // Tolerance — most frequent value (not first) to handle catalog datasheets
  const tolCounts = new Map<number, number>();
  const tolRe = /[±]\s*(\d+(?:\.\d+)?)\s*%/g;
  while ((m = tolRe.exec(text)) !== null) {
    const val = parseFloat(m[1]);
    if (val > 0 && val <= 20) tolCounts.set(val, (tolCounts.get(val) ?? 0) + 1);
  }
  if (tolCounts.size > 0) {
    let bestVal = 0, bestCount = 0;
    for (const [val, count] of tolCounts) { if (count > bestCount) { bestVal = val; bestCount = count; } }
    if (bestVal > 0) props.push({ key: "tolerance_pct", value: bestVal, unit: "%", source });
  }
  // TCR — support ℃ (U+2103), bare ppm
  const tcrRe = /[±+-]?\s*(\d+)\s*ppm\s*(?:[\s./]*[°˚℃]?\s*[CK℃])?/gi;
  while ((m = tcrRe.exec(text)) !== null) {
    const before = text.substring(Math.max(0, m.index - 5), m.index);
    if (/[~]/.test(before)) continue;
    props.push({ key: "tcr_ppm", value: parseInt(m[1]), unit: "ppm/C", source });
    break;
  }
  const pwrProp = scanSpecRow(text, /(?:rated\s*power|power\s*rating)/i, (v) => v > 0 && v <= 100, "power_rating", "W", source);
  if (pwrProp) props.push(pwrProp);
  const vProp = scanSpecRow(text, /(?:working\s*voltage|rated\s*voltage|max.*voltage)/i, (v) => v > 0 && v <= 10000, "voltage_max", "V", source);
  if (vProp) props.push(vProp);
  return props;
}

function extractCapacitorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  const esrRe = /ESR\s*[:=<≤]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*(?:Ω|Ohm|ohm)/gi;
  while ((m = esrRe.exec(text)) !== null) {
    props.push({ key: "esr", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "Ohm", source });
    break;
  }
  if (!props.some((p) => p.key === "esr")) {
    const esrProp = scanSpecRow(text, /\bESR\b/i, (v) => v > 0 && v < 10000, "esr", "Ohm", source);
    if (esrProp) props.push(esrProp);
  }
  const rippleRe = /ripple\s*(?:current)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*A/gi;
  while ((m = rippleRe.exec(text)) !== null) {
    props.push({ key: "ripple_current", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "A", source });
    break;
  }
  // Dissipation factor — D.F., tan δ, decimal or percentage
  const dfPatterns = [
    /(?:D\.?\s*F\.?|dissipation\s*factor|tan\s*[δd])\s*[:=<≤(]?\s*(\d+(?:\.\d+)?)\s*%/gi,
    /(?:D\.?\s*F\.?|dissipation\s*factor|tan\s*[δd])\s*[:=<≤(]?\s*(0\.\d+)/gi,
  ];
  for (const dfRe of dfPatterns) {
    while ((m = dfRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val < 100) { props.push({ key: "dissipation_factor", value: val, unit: "%", source }); break; }
    }
    if (props.some((p) => p.key === "dissipation_factor")) break;
  }
  return props;
}

function extractCapacitorKeywords(text: string): string[] {
  const kw: string[] = [];
  let m: RegExpExecArray | null;
  const re = /\b(X[5-8][RSPTUVW]|C0G|NP0|Y5[UV])\b/g;
  while ((m = re.exec(text)) !== null) kw.push(m[1]);
  return [...new Set(kw)];
}

function extractInductorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  const dcrRe = /(?:DCR|DC\s*Resistance)\s*[:=<≤]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*(?:Ω|Ohm|ohm)/gi;
  while ((m = dcrRe.exec(text)) !== null) {
    props.push({ key: "dcr", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "Ohm", source });
    break;
  }
  const isatRe = /(?:saturation|I\s*sat|Isat)\s*(?:current)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*A/gi;
  while ((m = isatRe.exec(text)) !== null) {
    props.push({ key: "i_sat", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "A", source });
    break;
  }
  const srfRe = /SRF\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(k|M|G)?\s*Hz/gi;
  while ((m = srfRe.exec(text)) !== null) {
    const mult = m[2] === "G" ? 1e9 : m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1;
    props.push({ key: "srf", value: parseFloat(m[1]) * mult, unit: "Hz", source });
    break;
  }
  const tableProps = scanTable(text, [
    { pattern: /\bDCR\b/i, key: "dcr", unit: "Ohm", multiplier: 0.001 },
    { pattern: /\bIsat\b|Satura/i, key: "i_sat", unit: "A" },
    { pattern: /\bInductance\b/i, key: "inductance", unit: "H", multiplier: 1e-6 },
  ], source);
  const existing = new Set(props.map((p) => p.key));
  for (const tp of tableProps) { if (!existing.has(tp.key)) props.push(tp); }
  return props;
}

function extractDiodeProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // VF inline
  const vfRe = /V[Ff]\s*[:=]\s*(\d+\.?\d*)\s*V/g;
  while ((m = vfRe.exec(text)) !== null) {
    const v = parseFloat(m[1]); if (v > 0 && v < 10) { props.push({ key: "vf", value: v, unit: "V", source }); break; }
  }
  // VF tabular
  if (!props.some((p) => p.key === "vf")) {
    const vfTab = /V[Ff]\s{4,}(\d+\.?\d*)/g;
    while ((m = vfTab.exec(text)) !== null) {
      const v = parseFloat(m[1]); if (v > 0 && v < 10) { props.push({ key: "vf", value: v, unit: "V", source }); break; }
    }
  }
  if (!props.some((p) => p.key === "vf")) {
    const vfP = scanSpecRow(text, /(?:Forward\s*Voltage|V[Ff]\b)/, (v) => v > 0 && v < 10, "vf", "V", source);
    if (vfP) props.push(vfP);
  }
  // VRRM/VRWM — require explicit separator to avoid graph labels
  const vrRe = /V\s*(?:RRM|RSM|RWM)\s*[:=]\s*(\d+\.?\d*)\s*V/g;
  while ((m = vrRe.exec(text)) !== null) {
    const v = parseFloat(m[1]); if (v >= 5) { props.push({ key: "vrrm", value: v, unit: "V", source }); break; }
  }
  if (!props.some((p) => p.key === "vrrm")) {
    const vrP = scanSpecRow(text, /(?:V\s*RRM\b|V\s*RSM\b|V\s*RWM\b|Reverse\s*(?:Repetitive\s*)?(?:Peak\s*)?Voltage|Reverse\s*Working\s*Voltage)/i,
      (v) => v >= 5 && v <= 10000, "vrrm", "V", source);
    if (vrP) props.push(vrP);
  }
  // VBR (Zener/TVS)
  const vbrP = scanSpecRow(text, /(?:Breakdown\s*Voltage|V\s*BR\b)/i, (v) => v > 0 && v <= 10000, "vbr", "V", source);
  if (vbrP) props.push(vbrP);
  // trr
  const trrRe = /t\s*rr\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(n|u|μ|µ)?\s*s/gi;
  while ((m = trrRe.exec(text)) !== null) {
    const mult = m[2] === "n" ? 1e-9 : (m[2] === "u" || m[2] === "μ" || m[2] === "µ") ? 1e-6 : 1;
    props.push({ key: "trr", value: parseFloat(m[1]) * mult, unit: "s", source });
    break;
  }
  // IF(AV)
  const ifP = scanSpecRow(text, /(?:Average.*Forward.*Current|I[Ff]\s*\(\s*AV\s*\)|Average\s*Rectified)/i,
    (v) => v > 0 && v <= 1000, "if_avg", "A", source);
  if (ifP) props.push(ifP);
  return props;
}

function extractTransistorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // VDS
  const vdsP = scanSpecRow(text, /(?:Drain[\s-]*Source\s*Voltage|V[Dd][Ss][Ss]?\b)/,
    (v) => v >= 5 && v <= 10000, "vds_max", "V", source);
  if (vdsP) props.push(vdsP);
  // RDS(on) — pattern 1: inline with unit
  const rdsRe = /R[Dd][Ss]\s*\(\s*[Oo][Nn]\s*\)\s*[:=]?\s*(\d+\.?\d*)\s*(m?)\s*(?:Ω|Ohm|ohm)/g;
  while ((m = rdsRe.exec(text)) !== null) {
    props.push({ key: "rds_on", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "Ohm", source });
    break;
  }
  // Pattern 2: "0.175 at VGS = -10 V" near RDS(on)
  if (!props.some((p) => p.key === "rds_on")) {
    const lines = text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      if (/R[Dd][Ss]\s*\(\s*[Oo][Nn]\s*\)/.test(lines[li])) {
        for (let lj = Math.max(0, li - 3); lj < Math.min(lines.length, li + 4); lj++) {
          const vm = lines[lj].match(/(\d+\.?\d*)\s*(?:at|@)\s*V[Gg][Ss]\s*=\s*-?\d/);
          if (vm) { const v = parseFloat(vm[1]); if (v > 0 && v < 100) { props.push({ key: "rds_on", value: v, unit: "Ohm", source }); break; } }
        }
        if (props.some((p) => p.key === "rds_on")) break;
      }
    }
  }
  // Pattern 3: spec row fallback
  if (!props.some((p) => p.key === "rds_on")) {
    const rdsP = scanSpecRow(text, /R[Dd][Ss]\s*\(\s*[Oo][Nn]\s*\)/, (v) => v > 0 && v < 100, "rds_on", "Ohm", source);
    if (rdsP) props.push(rdsP);
  }
  // Qg
  const qgRe = /Q[Gg]\s*[:=]?\s*(\d+\.?\d*)\s*(n|u|μ|µ)?\s*C/g;
  while ((m = qgRe.exec(text)) !== null) {
    const mult = m[2] === "n" ? 1e-9 : (m[2] === "u" || m[2] === "μ" || m[2] === "µ") ? 1e-6 : 1;
    props.push({ key: "qg", value: parseFloat(m[1]) * mult, unit: "C", source });
    break;
  }
  if (!props.some((p) => p.key === "qg")) {
    const qgP = scanSpecRow(text, /(?:Total\s*Gate\s*Charge|Q[Gg]\b)/, (v) => v > 0 && v < 10000, "qg", "nC", source);
    if (qgP) props.push(qgP);
  }
  // Id continuous (avoid IDM pulsed)
  const idP = scanSpecRow(text, /Continuous\s*Drain\s*Current/i, (v) => v > 0 && v <= 1000, "id_max", "A", source);
  if (idP) props.push(idP);
  // Vgs(th)
  const vgsP = scanSpecRow(text, /(?:Gate[\s-]*Source\s*Threshold|V[Gg][Ss]\s*\(\s*th\s*\))/,
    (v) => v > 0 && v < 20, "vgs_th", "V", source);
  if (vgsP) props.push(vgsP);
  return props;
}

function extractICProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // Supply voltage — collect all, pick widest range. Support en-dash/em-dash.
  const vsupRe = /V[CcDd][CcDd]\s*[:=]?\s*(\d+\.?\d*)\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*V/g;
  let bestMin = Infinity, bestMax = 0;
  while ((m = vsupRe.exec(text)) !== null) {
    const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
    if (hi > lo && hi < 100 && (hi - lo) > (bestMax - bestMin)) { bestMin = lo; bestMax = hi; }
  }
  // Also try standalone ranges near "Operating/Supply Voltage"
  const altRe = /(\d+\.?\d*)\s*V?\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*V\b/g;
  for (const line of text.split("\n")) {
    if (!/(?:supply|operating)\s*voltage/i.test(line)) continue;
    while ((m = altRe.exec(line)) !== null) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (hi > lo && hi < 100 && (hi - lo) > (bestMax - bestMin)) { bestMin = lo; bestMax = hi; }
    }
  }
  if (bestMax > bestMin && bestMax < 100) {
    props.push({ key: "vcc_min", value: bestMin, unit: "V", source });
    props.push({ key: "vcc_max", value: bestMax, unit: "V", source });
  }
  if (props.length === 0) {
    const vsupP = scanSpecRow(text, /(?:Supply\s*Voltage|V[CcDd][CcDd]\b|Operating\s*Voltage)/i,
      (v) => v > 0 && v < 100, "vcc_max", "V", source);
    if (vsupP) props.push(vsupP);
  }
  // Quiescent current — IDD, ICC, Iq. Support µ (U+00B5).
  const iqRe = /I[QqCcDd][CcDdQq]?\s*[:=]?\s*(\d+\.?\d*)\s*([uμµ]|m)?\s*A/g;
  while ((m = iqRe.exec(text)) !== null) {
    const mult = (m[2] === "u" || m[2] === "μ" || m[2] === "µ") ? 1e-6 : m[2] === "m" ? 1e-3 : 1;
    const val = parseFloat(m[1]) * mult;
    if (val > 0 && val < 1) { props.push({ key: "iq", value: val, unit: "A", source }); break; }
  }
  // Fallback: "NNN µA at X.XV"
  if (!props.some((p) => p.key === "iq")) {
    const actRe = /(\d+\.?\d*)\s*([uμµ]|m)A\s*(?:\/MHz\s*)?(?:at|@)\s*[\d.]+\s*V/gi;
    while ((m = actRe.exec(text)) !== null) {
      const mult = (m[2] === "u" || m[2] === "μ" || m[2] === "µ") ? 1e-6 : m[2] === "m" ? 1e-3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0 && val < 0.1) { props.push({ key: "iq", value: val, unit: "A", source }); break; }
    }
  }
  return props;
}

// ── Deduplication ──

function deduplicateProperties(props: ExtractedProperty[]): ExtractedProperty[] {
  const seen = new Set<string>();
  return props.filter((p) => { const k = `${p.key}:${p.value}:${p.unit}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ── Main entry point ──

export function extractComponentProperties(
  text: string, category: string, subcategory: string, source: string,
): ExtractionResult {
  const result: ExtractionResult = { properties: [], keywords: [] };
  if (!text || text.length < 10) return result;

  const keywordText = source === "datasheet" ? text.substring(0, Math.floor(text.length * 0.4)) : text;

  result.properties.push(...extractGenericNumericValues(text, source, category));
  result.keywords.push(...extractComplianceKeywords(keywordText));
  result.keywords.push(...extractTemperatureRange(text));
  result.keywords.push(...extractFeatureKeywords(keywordText));

  const combined = `${category.toLowerCase()} ${subcategory.toLowerCase()}`;
  if (combined.includes("resistor")) result.properties.push(...extractResistorProperties(text, source));
  if (combined.includes("capacitor")) { result.properties.push(...extractCapacitorProperties(text, source)); result.keywords.push(...extractCapacitorKeywords(keywordText)); }
  if (combined.includes("inductor") || combined.includes("coil") || combined.includes("choke")) result.properties.push(...extractInductorProperties(text, source));
  if (combined.includes("diode")) result.properties.push(...extractDiodeProperties(text, source));
  if (combined.includes("transistor") || combined.includes("mosfet") || combined.includes("thyristor")) result.properties.push(...extractTransistorProperties(text, source));
  if (combined.includes("processor") || combined.includes("controller") || combined.includes("driver") ||
      combined.includes("interface") || combined.includes("logic") || combined.includes("memory") ||
      combined.includes("power management") || combined.includes("pmic")) result.properties.push(...extractICProperties(text, source));

  result.properties = deduplicateProperties(result.properties);
  result.keywords = [...new Set(result.keywords.map((k) => k.toLowerCase()))];
  return result;
}
