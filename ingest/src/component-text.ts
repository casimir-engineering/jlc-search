/**
 * Generic component-aware text processing module.
 * Extracts structured properties and keywords from arbitrary text.
 * Works with text from any source: datasheets, descriptions, API attributes.
 *
 * Category determines which extractors run. All extractors are regex-based.
 * Includes table-aware extraction for pdftotext -layout output.
 */
import { extractNumericFromText } from "./attrs.ts";
import type { ExtractedProperty, ExtractionResult } from "./types.ts";

// ── Helpers ──

function findNumberNear(line: string, colStart: number, colEnd: number): number | null {
  const region = line.substring(Math.max(0, colStart - 5), Math.min(line.length, colEnd + 15));
  // Reject numbers followed by unit-like chars (e.g., "100KHz" → skip)
  const m = region.match(/(\d+\.?\d*)(?![KkMGHz%])/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Scan a table in pdftotext -layout output.
 * Locates header keywords across a multi-line header block (up to 8 lines),
 * then reads numeric values from the first data row.
 */
function scanTable(
  text: string,
  headerKeywords: { pattern: RegExp; key: string; unit: string; multiplier?: number }[],
  source: string,
): ExtractedProperty[] {
  const lines = text.split("\n");
  const props: ExtractedProperty[] = [];
  for (let i = 0; i < lines.length; i++) {
    const found: { key: string; unit: string; col: number; multiplier: number }[] = [];
    const headerEnd = Math.min(i + 8, lines.length);
    for (let h = i; h < headerEnd; h++) {
      for (const kw of headerKeywords) {
        if (found.some((f) => f.key === kw.key)) continue;
        const m = lines[h].match(kw.pattern);
        if (m && m.index !== undefined) {
          // Skip if keyword is part of a prose sentence
          const after = lines[h].substring(m.index + m[0].length, m.index + m[0].length + 15);
          if (/^\s*(?:is|was|are|should|measured)/i.test(after)) continue;
          found.push({ key: kw.key, unit: kw.unit, col: m.index, multiplier: kw.multiplier ?? 1 });
        }
      }
    }
    if (found.length < 2) continue;
    for (let j = headerEnd; j < Math.min(i + 30, lines.length); j++) {
      const dataLine = lines[j];
      const nums = [...dataLine.matchAll(/\d+\.?\d*/g)];
      if (nums.length < 2) continue;
      if (/^\s*\(/.test(dataLine.trim()) && !/\d{2,}/.test(dataLine)) continue;
      for (const f of found) {
        const val = findNumberNear(dataLine, f.col, f.col + 15);
        if (val !== null && val > 0) props.push({ key: f.key, value: val * f.multiplier, unit: f.unit, source });
      }
      if (props.length > 0) return props;
    }
  }
  return props;
}

/**
 * Scan spec table rows: "Label ... value unit" on one line.
 * Only considers numbers AFTER the label position to avoid section-number false positives.
 * Optionally skips lines matching skipRe (e.g., temperature coefficient rows).
 */
function scanSpecRow(
  text: string, labelRe: RegExp, valueFilter: (v: number) => boolean,
  key: string, unit: string, source: string, skipRe?: RegExp,
): ExtractedProperty | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const labelMatch = line.match(labelRe);
    if (!labelMatch || labelMatch.index === undefined) continue;
    if (skipRe && skipRe.test(line)) continue;
    // Skip product-summary header lines with multiple (unit) columns
    if (/\([A-Za-z]+\).*\([A-Za-z]+\)/.test(line)) continue;
    // Skip pin-assignment lines (e.g., "VDD 1 14 GND")
    if (/\bGND\b|\bVSS\b/.test(line) && /\d+\s+\d+/.test(line)) continue;
    // Strip test conditions like "VGS = 10 V", "IF = 1A", "TC = 25°C"
    const afterLabel = line.substring(labelMatch.index + labelMatch[0].length);
    const cleaned = afterLabel.replace(/[A-Z]{1,4}\s*=\s*-?\d+\.?\d*\s*[a-zA-Zμµ°℃]*/g, "");
    const nums = [...cleaned.matchAll(/(?<![.@(])(\d+\.?\d*)(?!\s*[°℃])/g)];
    for (const m of nums) {
      const val = parseFloat(m[1]);
      if (valueFilter(val)) return { key, value: val, unit, source };
    }
    // Try next 2 lines if no number found on label line
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const nextCleaned = lines[j].replace(/[A-Z]{1,4}\s*=\s*-?\d+\.?\d*\s*[a-zA-Zμµ°℃]*/g, "");
      for (const m of nextCleaned.matchAll(/(?<![.@(])(\d+\.?\d*)(?!\s*[°℃])/g)) {
        const val = parseFloat(m[1]);
        if (valueFilter(val)) return { key, value: val, unit, source };
      }
    }
  }
  return null;
}

// ── Generic extractors ──

function extractGenericNumericValues(text: string, source: string, category: string): ExtractedProperty[] {
  const searchText = source === "datasheet" ? text.substring(0, 2000) : text;
  const nums = extractNumericFromText(searchText);
  const c = category.toLowerCase();
  return nums
    .filter((n) => {
      if (n.unit === "H" && (c.includes("processor") || c.includes("controller") ||
          c.includes("memory") || c.includes("logic") || c.includes("resistor"))) return false;
      // Filter A (ampere) false positives from part numbers like "ERA3A", "ATtiny44A"
      if (n.unit === "A" && n.value > 100 && c.includes("resistor")) return false;
      return true;
    })
    .map((n) => ({ key: n.unit.toLowerCase(), value: n.value, unit: n.unit, source }));
}

function extractComplianceKeywords(text: string): string[] {
  const kw: string[] = [];
  const p: [RegExp, string][] = [
    [/\bAEC-Q\d+\b/gi, ""], [/\bRoHS\b/gi, "RoHS"], [/\bREACH\b/gi, "REACH"],
    [/\bHalogen[\s-]?Free\b/gi, "Halogen-Free"], [/\bMSL[\s-]?\d\b/gi, ""],
    [/\bUL[\s-]?94\b/gi, ""], [/\bautomotive[\s-]?grade\b/gi, "automotive-grade"],
  ];
  for (const [re, fixed] of p) { const m = text.match(re); if (m) kw.push(fixed || m[0]); }
  return kw;
}

function extractTemperatureRange(text: string): string[] {
  const re = /(-?\d+)\s*[°˚℃]?\s*C?\s*(?:to|~|\.\.\.?)\s*[+]?(\d+)\s*[°˚℃]?\s*C/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lo = parseInt(m[1]), hi = parseInt(m[2]);
    if (lo >= -65 && lo < 0 && hi > 50 && hi <= 300) return [`${lo}C~${hi}C`];
  }
  return [];
}

function extractFeatureKeywords(text: string): string[] {
  const kw: string[] = [];
  const feats = [
    /\blow[\s-]?ESR\b/gi, /\blow[\s-]?noise\b/gi, /\blow[\s-]?power\b/gi,
    /\bhigh[\s-]?speed\b/gi, /\bshielded\b/gi, /\bunshielded\b/gi,
    /\bwirewound\b/gi, /\bthin[\s-]?film\b/gi, /\bthick[\s-]?film\b/gi,
    /\bmetal[\s-]?film\b/gi, /\banti[\s-]?surge\b/gi,
    /\blow[\s-]?dropout\b/gi, /\bLDO\b/g, /\bPWM\b/g,
    /\bI2C\b/gi, /\bSPI\b/g, /\bUART\b/g, /\bEUSART\b/gi,
    /\bUSB\b/g, /\bCAN\s*(?:bus|2\.0|FD)\b/gi, /\bEthernet\b/gi,
    /\bBluetooth\b/gi, /\bWiFi\b/gi, /\bLoRa\b/gi, /\bZigbee\b/gi,
    /\bADC\b/g, /\bDAC\b/g, /\bDMA\b/g, /\bJTAG\b/g, /\bSWD\b/g,
    /\bRS-?232\b/gi, /\bRS-?485\b/gi, /\bLIN\b/g,
  ];
  for (const re of feats) {
    const m = text.match(re);
    if (m) kw.push(m[0].replace(/\s+/g, "-").toLowerCase());
  }
  return kw;
}

// ── Category-specific extractors ──

function extractResistorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // Tolerance — most frequent value to handle catalog datasheets
  const tolCounts = new Map<number, number>();
  const tolRe = /[±]\s*(\d+(?:\.\d+)?)\s*%/g;
  while ((m = tolRe.exec(text)) !== null) {
    const val = parseFloat(m[1]);
    if (val > 0 && val <= 20) tolCounts.set(val, (tolCounts.get(val) ?? 0) + 1);
  }
  if (tolCounts.size > 0) {
    let best = 0, bestN = 0;
    for (const [v, n] of tolCounts) { if (n > bestN) { best = v; bestN = n; } }
    if (best > 0) props.push({ key: "tolerance_pct", value: best, unit: "%", source });
  }
  // TCR — support ℃, bare ppm, ×10^-6/K
  const tcrPatterns = [
    /[±+-]?\s*(\d+)\s*ppm\s*(?:[\s./]*[°˚℃]?\s*[CK℃])?/gi,
    /[±+-]?\s*(\d+)\s*[×x]\s*10\s*[-–]\s*6\s*\/\s*K/gi,
  ];
  for (const tcrRe of tcrPatterns) {
    while ((m = tcrRe.exec(text)) !== null) {
      const before = text.substring(Math.max(0, m.index - 5), m.index);
      if (/[~]/.test(before)) continue;
      props.push({ key: "tcr_ppm", value: parseInt(m[1]), unit: "ppm/C", source });
      break;
    }
    if (props.some((p) => p.key === "tcr_ppm")) break;
  }
  // Power rating — support fractions like 1/10W
  const fracPwr = text.match(/(?:rated\s*power|power\s*rating)\s*[:=]?\s*(\d+)\s*\/\s*(\d+)\s*W/i);
  if (fracPwr) props.push({ key: "power_rating", value: parseInt(fracPwr[1]) / parseInt(fracPwr[2]), unit: "W", source });
  if (!props.some((p) => p.key === "power_rating")) {
    const pwrP = scanSpecRow(text, /(?:rated\s*power|power\s*rating)/i, (v) => v > 0 && v <= 100, "power_rating", "W", source);
    if (pwrP) props.push(pwrP);
  }
  const vP = scanSpecRow(text, /(?:working\s*voltage|rated\s*voltage|max.*voltage)/i, (v) => v > 0 && v <= 10000, "voltage_max", "V", source);
  if (vP) props.push(vP);
  return props;
}

function extractCapacitorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // ESR — inline with proper Ω|\u2126|Ohm matching
  const esrRe = /ESR\s*[:=<≤]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*(?:Ω|\u2126|Ohm|ohm)/gi;
  while ((m = esrRe.exec(text)) !== null) {
    props.push({ key: "esr", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "Ohm", source });
    break;
  }
  if (!props.some((p) => p.key === "esr")) {
    const esrP = scanSpecRow(text, /\bESR\b/i, (v) => v > 0 && v < 10000, "esr", "Ohm", source);
    if (esrP) props.push(esrP);
  }
  // Ripple current — inline + spec row fallback
  const ripRe = /ripple\s*(?:current)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*A/gi;
  while ((m = ripRe.exec(text)) !== null) {
    props.push({ key: "ripple_current", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "A", source });
    break;
  }
  if (!props.some((p) => p.key === "ripple_current")) {
    const ripP = scanSpecRow(text, /\bripple\s*current\b/i, (v) => v > 0 && v < 100000, "ripple_current", "mA", source);
    if (ripP) props.push(ripP);
  }
  // Dissipation factor — prevent newline spanning with [ \t]*, handle (Max.)
  const dfRe = /(?:D\.?\s*F\.?|dissipation\s*factor|tan\s*[δd])(?:\s*\([^)]*\))?[ \t]*[:=<≤]?[ \t]*(\d+(?:\.\d+)?)\s*%?/gi;
  while ((m = dfRe.exec(text)) !== null) {
    const val = parseFloat(m[1]);
    if (val > 0 && val < 100) { props.push({ key: "dissipation_factor", value: val, unit: "%", source }); break; }
  }
  return props;
}

function extractCapacitorKeywords(text: string): string[] {
  const kw: string[] = [];
  let m: RegExpExecArray | null;
  // Support both digit-zero (C0G, NP0) and letter-O (COG, NPO) spellings
  const re = /\b(X[5-8][RSPTUVW]|C0G|COG|NP0|NPO|Y5[UV])\b/gi;
  while ((m = re.exec(text)) !== null) {
    // Normalize to canonical forms
    const val = m[1].toUpperCase().replace("COG", "C0G").replace("NPO", "NP0");
    kw.push(val);
  }
  return [...new Set(kw)];
}

function extractInductorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // Inline: DCR/RDC
  const dcrRe = /(?:DCR|RDC|R\s*DC|DC\s*Resistance)\s*[:=<≤]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*(?:Ω|\u2126|Ohm|ohm)/gi;
  while ((m = dcrRe.exec(text)) !== null) {
    props.push({ key: "dcr", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "Ohm", source });
    break;
  }
  // Inline: Isat
  const isatRe = /(?:saturation|I\s*sat|Isat)\s*(?:current)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*A/gi;
  while ((m = isatRe.exec(text)) !== null) {
    props.push({ key: "i_sat", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "A", source });
    break;
  }
  // Inline: Irms
  const irmsRe = /(?:I\s*rms|rated\s*current|heating\s*current)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*A/gi;
  while ((m = irmsRe.exec(text)) !== null) {
    props.push({ key: "i_rms", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "A", source });
    break;
  }
  // Inline: SRF
  const srfRe = /SRF\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(k|M|G)?\s*Hz/gi;
  while ((m = srfRe.exec(text)) !== null) {
    const mult = m[2] === "G" ? 1e9 : m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1;
    props.push({ key: "srf", value: parseFloat(m[1]) * mult, unit: "Hz", source });
    break;
  }
  // Table-based extraction with expanded patterns
  const tableProps = scanTable(text, [
    { pattern: /\bDCR\b|\bRDC\b/i, key: "dcr", unit: "Ohm", multiplier: 0.001 },
    { pattern: /\bI\s*sat\b|Satura|ISAT/i, key: "i_sat", unit: "A" },
    { pattern: /\bI\s*rms\b|IRMS|Heating\s*(?:Rating)?\s*Current/i, key: "i_rms", unit: "A" },
    { pattern: /\bSRF\b/i, key: "srf", unit: "Hz", multiplier: 1e6 },
    { pattern: /\bInductance\b/i, key: "inductance", unit: "H", multiplier: 1e-6 },
  ], source);
  const existing = new Set(props.map((p) => p.key));
  for (const tp of tableProps) { if (!existing.has(tp.key)) props.push(tp); }
  return props;
}

function extractDiodeProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // VF — inline, tabular, spec row
  const vfRe = /V[Ff]\s*[:=]\s*(\d+\.?\d*)\s*V/g;
  while ((m = vfRe.exec(text)) !== null) {
    const v = parseFloat(m[1]); if (v > 0 && v < 10) { props.push({ key: "vf", value: v, unit: "V", source }); break; }
  }
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
  // VRRM/VRWM — require explicit separator
  const vrRe = /V\s*(?:RRM|RSM|RWM)\s*[:=]\s*(\d+\.?\d*)/g;
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
  // VZ (Zener voltage)
  const vzP = scanSpecRow(text, /(?:Zener\s*Voltage|V[Zz]\b)/i, (v) => v > 0 && v <= 200, "vz", "V", source);
  if (vzP) props.push(vzP);
  // trr
  const trrP = scanSpecRow(text, /\bt\s*rr\b/i, (v) => v > 0 && v < 10000, "trr", "ns", source);
  if (trrP) props.push(trrP);
  // IF(AV)
  const ifP = scanSpecRow(text, /(?:Average.*Forward.*Current|I[Ff]\s*\(\s*AV\s*\)|Average\s*Rectified)/i,
    (v) => v > 0 && v <= 1000, "if_avg", "A", source);
  if (ifP) props.push(ifP);
  return props;
}

function extractTransistorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // VDS — from absolute max table, skip product summary headers
  const vdsP = scanSpecRow(text, /(?:Drain[\s-]*Source\s*Voltage|V[Dd][Ss][Ss]?\b)/,
    (v) => v >= 5 && v <= 10000, "vds_max", "V", source);
  if (vdsP) props.push(vdsP);
  // RDS(on) — inline with Ω/Ohm unit
  const rdsRe = /R[Dd][Ss]\s*\(\s*[Oo][Nn]\s*\)\s*[:=]?\s*(\d+\.?\d*)\s*(m?)\s*(?:Ω|\u2126|Ohm|ohm)/g;
  while ((m = rdsRe.exec(text)) !== null) {
    props.push({ key: "rds_on", value: parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1), unit: "Ohm", source });
    break;
  }
  // "0.175 at VGS = -10 V" near RDS(on) — check for mΩ context
  if (!props.some((p) => p.key === "rds_on")) {
    const lines = text.split("\n");
    const hasMohm = /m\s*[ΩΩ]|mOhm|milliohm/i.test(text.substring(0, 3000));
    for (let li = 0; li < lines.length; li++) {
      if (/R[Dd][Ss]\s*\(\s*[Oo][Nn]\s*\)/.test(lines[li])) {
        for (let lj = Math.max(0, li - 2); lj < Math.min(lines.length, li + 3); lj++) {
          const vm = lines[lj].match(/(\d+\.?\d*)\s*(?:at|@)\s*V[Gg][Ss]\s*=\s*-?\d/);
          if (vm) {
            let val = parseFloat(vm[1]);
            // If text mentions mΩ and value > 1, it's likely milliohms
            if (hasMohm && val > 1) val *= 0.001;
            if (val > 0 && val < 100) { props.push({ key: "rds_on", value: val, unit: "Ohm", source }); break; }
          }
        }
        if (props.some((p) => p.key === "rds_on")) break;
      }
    }
  }
  if (!props.some((p) => p.key === "rds_on")) {
    const rdsP = scanSpecRow(text, /R[Dd][Ss]\s*\(\s*[Oo][Nn]\s*\)/, (v) => v > 0 && v < 100, "rds_on", "Ohm", source);
    if (rdsP) props.push(rdsP);
  }
  // Qg — prefer "Total Gate Charge" to avoid chart false positives
  const qgRe = /Q[Gg]\s*[:=]?\s*(\d+\.?\d*)\s*(n|u|μ|µ)?\s*C/g;
  while ((m = qgRe.exec(text)) !== null) {
    const mult = m[2] === "n" ? 1e-9 : (m[2] === "u" || m[2] === "μ" || m[2] === "µ") ? 1e-6 : 1;
    props.push({ key: "qg", value: parseFloat(m[1]) * mult, unit: "C", source });
    break;
  }
  if (!props.some((p) => p.key === "qg")) {
    const qgP = scanSpecRow(text, /Total\s*Gate\s*Charge/, (v) => v > 0 && v < 10000, "qg", "nC", source);
    if (qgP) props.push(qgP);
  }
  // Id — require "Continuous" or "Drain current" pattern; skip temp coefficient rows
  const idP = scanSpecRow(text, /(?:Continuous\s*[Dd]rain\s*[Cc]urrent|ID\s{2,}.*[Dd]rain\s+[Cc]urrent)/i,
    (v) => v > 0 && v <= 1000, "id_max", "A", source, /Temperature/);
  if (idP) props.push(idP);
  // Vgs(th) — skip temperature coefficient rows
  const vgsP = scanSpecRow(text, /(?:Gate[\s-]*Source\s*Threshold|V[Gg][Ss]\s*\(\s*th\s*\))/,
    (v) => v > 0 && v < 20, "vgs_th", "V", source, /Temperature\s*Coefficient/);
  if (vgsP) props.push(vgsP);
  return props;
}

function extractICProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  // Supply voltage — collect all, pick widest. Support en-dash/em-dash.
  const vsupRe = /V[CcDd][CcDd]\s*[:=]?\s*(\d+\.?\d*)\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*V/g;
  let bestMin = Infinity, bestMax = 0;
  while ((m = vsupRe.exec(text)) !== null) {
    const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
    if (hi > lo && hi < 100 && (hi - lo) > (bestMax - bestMin)) { bestMin = lo; bestMax = hi; }
  }
  // Also try: "X.XV to Y.YV" or "X.XV – Y.YV" near Operating/Supply Voltage
  const altRe = /(\d+\.?\d*)\s*V?\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*V/g;
  for (const line of text.split("\n")) {
    if (!/(?:supply|operating)\s*voltage/i.test(line)) continue;
    while ((m = altRe.exec(line)) !== null) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (hi > lo && hi < 100 && (hi - lo) > (bestMax - bestMin)) { bestMin = lo; bestMax = hi; }
    }
  }
  // Also try: "@X.XV - Y.YV" or "X.XV - Y.YV" in feature lines (first 80 lines)
  const featLines = text.split("\n").slice(0, 80);
  for (const line of featLines) {
    while ((m = altRe.exec(line)) !== null) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (lo >= 1 && hi <= 7 && hi > lo && (hi - lo) > (bestMax - bestMin)) { bestMin = lo; bestMax = hi; }
    }
  }
  if (bestMax > bestMin && bestMax < 100) {
    props.push({ key: "vcc_min", value: bestMin, unit: "V", source });
    props.push({ key: "vcc_max", value: bestMax, unit: "V", source });
  }
  // Quiescent current: IDD, ICC, Iq — support µ (U+00B5)
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

function extractConnectorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // Current rating — "Rated Current: 5A", "Current Rating: 2A", "额定电流：0.4A"
  const currentPatterns = [
    /(?:rated\s*current|current\s*rating|额定电流)\s*[:：=]?\s*(\d+\.?\d*)\s*(m?)\s*A/gi,
    /(\d+\.?\d*)\s*(m?)\s*A\s*(?:AC|DC)\b/gi,
  ];
  for (const re of currentPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
      if (val > 0 && val <= 200) { props.push({ key: "current_rating", value: val, unit: "A", source }); break; }
    }
    if (props.some((p) => p.key === "current_rating")) break;
  }

  // Voltage rating — "Voltage Rating: 250V", "Working Voltage: 1150V", "Rated voltage: 125V", "额定电压：50V"
  const voltagePatterns = [
    /(?:rated\s*voltage|voltage\s*rating|working\s*voltage|额定电压)\s*[:：=]?\s*(\d+\.?\d*)\s*V/gi,
    /(\d+\.?\d*)\s*V\s*(?:AC|DC)\b/gi,
  ];
  for (const re of voltagePatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 10000) { props.push({ key: "voltage_rating", value: val, unit: "V", source }); break; }
    }
    if (props.some((p) => p.key === "voltage_rating")) break;
  }

  // Withstanding / test voltage — "Withstanding Voltage: 1000V", "Testing Voltage: 950V", "耐电压：200V"
  const withstandRe = /(?:withstand(?:ing)?\s*voltag[eo]|test(?:ing)?\s*voltage|dielectric\s*(?:withstand(?:ing)?|strength)|耐电压)\s*[:：=]?\s*(\d+\.?\d*)\s*V/gi;
  while ((m = withstandRe.exec(text)) !== null) {
    const val = parseFloat(m[1]);
    if (val > 0 && val <= 10000) { props.push({ key: "withstand_voltage", value: val, unit: "V", source }); break; }
  }

  // Contact resistance — "Contact Resistance: 20mΩ", "接触电阻：20mΩ"
  const crPatterns = [
    /(?:contact\s*resistance|接触电阻)\s*[:：=<≤]?\s*(\d+\.?\d*)\s*(m?)\s*(?:Ω|\u2126|Ohm|ohm)/gi,
    /(?:contact\s*resistance|接触电阻)\s*[:：=<≤]?\s*(\d+\.?\d*)\s*m\s*(?:Ω|\u2126|Ohm|ohm)/gi,
  ];
  for (const re of crPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
      if (val > 0 && val < 10) { props.push({ key: "contact_resistance", value: val, unit: "Ohm", source }); break; }
    }
    if (props.some((p) => p.key === "contact_resistance")) break;
  }

  // Insulation resistance — "Insulation Resistance: 500MΩ", "绝缘电阻：500MΩ"
  // Note: some datasheets erroneously use "mΩ" for insulation (meaning MΩ) — handle both
  const irPatterns = [
    /(?:insulation\s*resistance|绝缘电阻)\s*[:：=]?\s*(?:[>＞]\s*)?(\d+\.?\d*)\s*(M|G|k|m)?\s*(?:Ω|\u2126|Ohm|ohm)/gi,
  ];
  for (const re of irPatterns) {
    while ((m = re.exec(text)) !== null) {
      const prefix = m[2];
      const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "k" ? 1e3 : prefix === "m" ? 1e-3 : 1;
      let val = parseFloat(m[1]) * mult;
      // If result is < 1 Ohm, it's probably MΩ mislabeled as mΩ
      if (val < 1) val = parseFloat(m[1]) * 1e6;
      if (val > 0) { props.push({ key: "insulation_resistance", value: val, unit: "Ohm", source }); break; }
    }
    if (props.some((p) => p.key === "insulation_resistance")) break;
  }

  // Contact pitch — "X.XXmm pitch", "XPH" pattern, or "pitch: 2.54mm"
  const pitchPatterns = [
    /(?:pitch|间距)\s*[:：=]?\s*(\d+\.?\d*)\s*mm/gi,
    /(\d+\.?\d*)\s*mm\s*pitch/gi,
    /(\d+\.?\d*)\s*\*\s*PH\b/gi,          // "1.00*PH" pattern from FPC datasheets
  ];
  for (const re of pitchPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 0.3 && val <= 10) { props.push({ key: "pitch", value: val, unit: "mm", source }); break; }
    }
    if (props.some((p) => p.key === "pitch")) break;
  }
  // Fallback: infer pitch from part name/title containing common pitch values
  if (!props.some((p) => p.key === "pitch")) {
    const titleRe = /(?:^|\n)[^\n]*(?:product|title|part|型号|产品)[^\n]*?(\d+\.\d+)\s*mm/i;
    const tm = text.match(titleRe);
    if (tm) {
      const val = parseFloat(tm[1]);
      if (val >= 0.3 && val <= 10) props.push({ key: "pitch", value: val, unit: "mm", source });
    }
  }

  // Mating cycles / durability — ">3000", "Mating: 500 cycles"
  const matingRe = /(?:mating|insertion|durability|插拔次数|寿命)\s*(?:cycles?)?\s*[:：=]?\s*(?:[>＞]\s*)?(\d+)/gi;
  while ((m = matingRe.exec(text)) !== null) {
    const val = parseInt(m[1]);
    if (val >= 10 && val <= 100000) { props.push({ key: "mating_cycles", value: val, unit: "cycles", source }); break; }
  }

  return props;
}

function extractConnectorKeywords(text: string): string[] {
  const kw: string[] = [];
  let m: RegExpExecArray | null;

  // IP rating
  const ipRe = /\b(IP\d{2})\b/gi;
  while ((m = ipRe.exec(text)) !== null) kw.push(m[1].toUpperCase());

  // Wire gauge (AWG)
  const awgRe = /\b(\d{1,2})\s*AWG\b/gi;
  while ((m = awgRe.exec(text)) !== null) kw.push(`${m[1]}AWG`);

  // Connector material keywords
  if (/\bgold[\s-]*plat/i.test(text)) kw.push("gold-plated");
  if (/\btin[\s-]*plat/i.test(text)) kw.push("tin-plated");
  if (/\bnickel[\s-]*plat/i.test(text)) kw.push("nickel-plated");

  // Housing / insulator materials
  if (/\bLCP\b/.test(text)) kw.push("LCP");
  if (/\bPA6T\b/i.test(text)) kw.push("PA6T");
  if (/\bPA9T\b/i.test(text)) kw.push("PA9T");
  if (/\bNylon\s*66\b/i.test(text)) kw.push("Nylon66");
  if (/\bPBT\b/.test(text)) kw.push("PBT");
  if (/\bPPS\b/.test(text)) kw.push("PPS");
  if (/\bPEEK\b/.test(text)) kw.push("PEEK");

  // Waterproof / sealing
  if (/\bwaterproof\b/i.test(text)) kw.push("waterproof");
  if (/\bsealed\b/i.test(text)) kw.push("sealed");

  // Connector type keywords
  if (/\bSMT\b|surface\s*mount/i.test(text)) kw.push("SMT");
  if (/\bthrough[\s-]?hole\b|THT\b/i.test(text)) kw.push("through-hole");
  if (/\bright[\s-]?angle\b/i.test(text)) kw.push("right-angle");

  return [...new Set(kw)];
}

// ── Circuit Protection extractors ──

function extractCircuitProtectionProperties(text: string, source: string): ExtractionResult {
  const props: ExtractedProperty[] = [];
  const keywords: string[] = [];

  // Detect sub-type from text content
  const isTVS = /\bTVS\b|transient\s*voltage\s*suppress/i.test(text);
  const isESD = /\bESD\b|electrostatic/i.test(text);
  const isFuse = /\bfuse\b/i.test(text);
  const isPTC = /\bPPTC\b|\bPTC\b|\bresettable\b|\bPolySwitch\b/i.test(text);
  const isVaristor = /\bvaristor\b|\bMOV\b|metal\s*oxide\s*varistor/i.test(text);
  const isGDT = /\bGDT\b|gas\s*discharge|spark\s*gap|surge\s*arrester/i.test(text);

  // ── TVS / ESD properties ──
  if (isTVS || isESD) {
    // VRWM (Reverse standoff voltage)
    const vrwmP = scanSpecRow(text, /(?:Stand[\s-]*off\s*Voltage|V\s*(?:RWM|R)\b)/i,
      (v) => v > 0 && v <= 500, "vrwm", "V", source);
    if (vrwmP) props.push(vrwmP);

    // VBR (Breakdown voltage)
    const vbrP = scanSpecRow(text, /(?:Breakdown\s*Voltage|V\s*BR\b)/i,
      (v) => v > 0 && v <= 10000, "vbr", "V", source);
    if (vbrP) props.push(vbrP);

    // VC (Clamping voltage)
    const vcP = scanSpecRow(text, /(?:Clamping\s*Voltage|V\s*C\b|V\s*CL\b)/i,
      (v) => v > 0 && v <= 10000, "vc_clamp", "V", source);
    if (vcP) props.push(vcP);

    // IPP (Peak pulse current)
    const ippP = scanSpecRow(text, /(?:Peak\s*(?:Pulse\s*)?Current|I\s*PP\b|I\s*PPM\b)/i,
      (v) => v > 0 && v <= 10000, "ipp", "A", source);
    if (ippP) props.push(ippP);

    // Peak pulse power
    const pppP = scanSpecRow(text, /(?:Peak\s*Pulse\s*Power|P\s*PPM?\b)/i,
      (v) => v > 0 && v <= 100000, "peak_pulse_power", "W", source);
    if (pppP) props.push(pppP);

    // Junction capacitance (for ESD especially)
    const cjP = scanSpecRow(text, /(?:Junction\s*Capacitance|C\s*J\b|capacitance)/i,
      (v) => v > 0 && v < 10000, "capacitance", "pF", source);
    if (cjP) props.push(cjP);

    // Inline capacitance pattern: "4 pF typical" or "capacitance :4 pF"
    if (!props.some((p) => p.key === "capacitance")) {
      let m: RegExpExecArray | null;
      const capRe = /(?:capacitance|C[Jj])\s*[:=]?\s*(\d+\.?\d*)\s*pF/gi;
      while ((m = capRe.exec(text)) !== null) {
        const v = parseFloat(m[1]);
        if (v > 0 && v < 10000) { props.push({ key: "capacitance", value: v, unit: "pF", source }); break; }
      }
    }

    // ESD rating inline: "Contact NkV" or "Air NkV"
    let em: RegExpExecArray | null;
    const esdContactRe = /(?:contact|IEC\s*61000-4-2\s*\(contact\))\s*[:=]?\s*[>±]?\s*(\d+)\s*kV/gi;
    while ((em = esdContactRe.exec(text)) !== null) {
      const v = parseInt(em[1]);
      if (v >= 1 && v <= 50) { keywords.push(`esd-contact-${v}kv`); break; }
    }
    const esdAirRe = /(?:air|IEC\s*61000-4-2\s*\(air\))\s*[:=]?\s*[>±]?\s*(\d+)\s*kV/gi;
    while ((em = esdAirRe.exec(text)) !== null) {
      const v = parseInt(em[1]);
      if (v >= 1 && v <= 50) { keywords.push(`esd-air-${v}kv`); break; }
    }

    // Directionality keywords
    if (/\buni[\s-]*directional\b/i.test(text)) keywords.push("unidirectional");
    if (/\bbi[\s-]*directional\b/i.test(text)) keywords.push("bidirectional");

    keywords.push("tvs");
    if (isESD) keywords.push("esd");
  }

  // ── Fuse properties (disposable / traditional) ──
  if (isFuse && !isPTC) {
    // Rated current
    const ratedIP = scanSpecRow(text, /(?:Rated\s*Current|Ampere\s*Rating|Current\s*Rating|I\s*[Nn]\b)/i,
      (v) => v > 0 && v <= 1000, "rated_current", "A", source);
    if (ratedIP) props.push(ratedIP);

    // Voltage rating
    const vRateP = scanSpecRow(text, /(?:Voltage\s*Rating|Rated\s*Voltage|Nominal\s*Voltage)/i,
      (v) => v > 0 && v <= 10000, "voltage_rating", "V", source);
    if (vRateP) props.push(vRateP);
    // Inline voltage in spec tables
    if (!props.some((p) => p.key === "voltage_rating")) {
      const vInline = text.match(/(?:voltage\s*rating|rated\s*voltage)\s*[:=]?\s*(\d+)\s*V/i);
      if (vInline) {
        const v = parseInt(vInline[1]);
        if (v > 0 && v <= 10000) props.push({ key: "voltage_rating", value: v, unit: "V", source });
      }
    }

    // Breaking capacity / interrupting rating
    const breakP = scanSpecRow(text, /(?:Breaking\s*Capacity|Interrupting\s*Rating|Interrupt\s*Rating)/i,
      (v) => v > 0 && v <= 200000, "breaking_capacity", "A", source);
    if (breakP) props.push(breakP);

    // I-squared-t (melting)
    const i2tP = scanSpecRow(text, /(?:I[²2]\s*t|melting\s*I[²2]\s*t|Nominal\s*Melting|I2t|I\u00B2t)/i,
      (v) => v > 0 && v <= 1000000, "i2t", "A2s", source);
    if (i2tP) props.push(i2tP);

    // Fuse type keywords
    if (/\btime[\s-]*lag\b|\bslow[\s-]*blow\b|\banti[\s-]*surge\b|\bslow[\s-]*acting\b/i.test(text)) keywords.push("slow-blow");
    if (/\bfast[\s-]*acting\b|\bquick[\s-]*acting\b|\bfast[\s-]*blow\b/i.test(text)) keywords.push("fast-blow");

    keywords.push("fuse");
  }

  // ── Resettable fuse (PTC/PPTC) properties ──
  if (isPTC) {
    // Hold current IH
    const ihP = scanSpecRow(text, /(?:Hold\s*Current|I\s*H\b)/i,
      (v) => v > 0 && v <= 100, "hold_current", "A", source);
    if (ihP) props.push(ihP);

    // Trip current IT
    const itP = scanSpecRow(text, /(?:Trip\s*Current|I\s*T\b)/i,
      (v) => v > 0 && v <= 200, "trip_current", "A", source);
    if (itP) props.push(itP);

    // Max voltage VMAX
    const vmaxP = scanSpecRow(text, /(?:V\s*MAX\b|Maximum.*Voltage)/i,
      (v) => v > 0 && v <= 1000, "voltage_max", "V", source);
    if (vmaxP) props.push(vmaxP);

    // Max current IMAX
    const imaxP = scanSpecRow(text, /(?:I\s*MAX\b|Maximum.*Current)/i,
      (v) => v > 0 && v <= 10000, "current_max", "A", source);
    if (imaxP) props.push(imaxP);

    keywords.push("resettable-fuse", "ptc");
  }

  // ── Varistor properties ──
  if (isVaristor) {
    // Varistor voltage V1mA
    const v1maP = scanSpecRow(text, /(?:Varistor\s*Voltage|V\s*1\s*mA\b)/i,
      (v) => v > 0 && v <= 10000, "varistor_voltage", "V", source);
    if (v1maP) props.push(v1maP);

    // Max AC voltage
    const vacP = scanSpecRow(text, /(?:Max(?:imum)?\s*(?:Allowable\s*)?(?:AC|A\.C\.)\s*(?:Voltage)?|VAC\b)/i,
      (v) => v > 0 && v <= 10000, "vac_max", "V", source);
    if (vacP) props.push(vacP);

    // Max DC voltage
    const vdcP = scanSpecRow(text, /(?:Max(?:imum)?\s*(?:Allowable\s*)?(?:DC|D\.C\.)\s*(?:Voltage)?|VDC\b)/i,
      (v) => v > 0 && v <= 10000, "vdc_max", "V", source);
    if (vdcP) props.push(vdcP);

    // Clamping voltage VC
    const vcVarP = scanSpecRow(text, /(?:Clamping\s*Voltage|V\s*C\b|VC\(V\))/i,
      (v) => v > 0 && v <= 50000, "vc_clamp", "V", source);
    if (vcVarP) props.push(vcVarP);

    // Max surge current (withstanding)
    const isurgeP = scanSpecRow(text, /(?:Surge\s*[Cc]urrent|Withstanding\s*Surge|Peak\s*Current|I\s*P\b)/i,
      (v) => v > 0 && v <= 100000, "surge_current", "A", source);
    if (isurgeP) props.push(isurgeP);

    // Energy absorption
    const energyP = scanSpecRow(text, /(?:Energy|Maximum\s*Energy|Energy\s*Absorption)/i,
      (v) => v > 0 && v <= 100000, "energy", "J", source);
    if (energyP) props.push(energyP);

    keywords.push("varistor", "mov");
  }

  // ── GDT (Gas Discharge Tube) properties ──
  if (isGDT) {
    // DC breakdown/spark-over voltage
    const vdcBreakP = scanSpecRow(text, /(?:(?:DC\s*)?(?:Spark|Breakdown)\s*Voltage|V\s*S\b|Static\s*Breakdown)/i,
      (v) => v > 0 && v <= 100000, "breakdown_voltage_dc", "V", source);
    if (vdcBreakP) props.push(vdcBreakP);

    // Impulse spark-over voltage
    const vImpP = scanSpecRow(text, /(?:Impulse\s*(?:Spark|Breakdown)|V\s*(?:100|1000)\b)/i,
      (v) => v > 0 && v <= 100000, "impulse_sparkover", "V", source);
    if (vImpP) props.push(vImpP);

    // Surge current (8/20us)
    const gdtSurgeP = scanSpecRow(text, /(?:Surge\s*(?:Current|Discharge)|Discharge\s*(?:Peak\s*)?Current|I\s*P\b|Nominal\s*Discharge)/i,
      (v) => v > 0 && v <= 200000, "surge_current", "A", source);
    if (gdtSurgeP) props.push(gdtSurgeP);

    // Insulation resistance
    const insP = scanSpecRow(text, /(?:Insulation\s*Resistance|R\s*ins\b)/i,
      (v) => v > 0, "insulation_resistance", "GOhm", source);
    if (insP) props.push(insP);

    keywords.push("gdt", "gas-discharge-tube");
  }

  // ── Table-based extraction for TVS multi-part tables ──
  if (isTVS || isESD) {
    const tableProps = scanTable(text, [
      { pattern: /\bV\s*R\b|Stand[\s-]*off/i, key: "vrwm", unit: "V" },
      { pattern: /\bV\s*BR\b|Breakdown/i, key: "vbr", unit: "V" },
      { pattern: /\bV\s*C\b|Clamp/i, key: "vc_clamp", unit: "V" },
      { pattern: /\bI\s*PP\b|Peak.*Current/i, key: "ipp", unit: "A" },
    ], source);
    const existing = new Set(props.map((p) => p.key));
    for (const tp of tableProps) { if (!existing.has(tp.key)) props.push(tp); }
  }

  // ── Table-based extraction for varistors ──
  if (isVaristor) {
    const tableProps = scanTable(text, [
      { pattern: /\bV\s*1\s*mA\b|Varistor\s*Voltage/i, key: "varistor_voltage", unit: "V" },
      { pattern: /\bV\s*C\b|Clamp/i, key: "vc_clamp", unit: "V" },
      { pattern: /\bEnergy\b/i, key: "energy", unit: "J" },
      { pattern: /\bSurge\s*[Cc]urrent|IP\b/i, key: "surge_current", unit: "A" },
    ], source);
    const existing = new Set(props.map((p) => p.key));
    for (const tp of tableProps) { if (!existing.has(tp.key)) props.push(tp); }
  }

  // ── Table-based extraction for PTC ──
  if (isPTC) {
    const tableProps = scanTable(text, [
      { pattern: /\bI\s*H\b|Hold/i, key: "hold_current", unit: "A" },
      { pattern: /\bI\s*T\b|Trip/i, key: "trip_current", unit: "A" },
      { pattern: /\bV\s*MAX\b/i, key: "voltage_max", unit: "V" },
      { pattern: /\bI\s*MAX\b/i, key: "current_max", unit: "A" },
    ], source);
    const existing = new Set(props.map((p) => p.key));
    for (const tp of tableProps) { if (!existing.has(tp.key)) props.push(tp); }
  }

  return { properties: props, keywords };
}

function extractCircuitProtectionKeywords(text: string): string[] {
  const kw: string[] = [];
  // IEC standard compliance
  const iecPatterns: [RegExp, string][] = [
    [/\bIEC[\s-]*61000-4-2\b/gi, "iec-61000-4-2"],
    [/\bIEC[\s-]*61000-4-4\b/gi, "iec-61000-4-4"],
    [/\bIEC[\s-]*61000-4-5\b/gi, "iec-61000-4-5"],
    [/\bIEC[\s-]*61312\b/gi, "iec-61312"],
    [/\bIEC[\s-]*60127\b/gi, "iec-60127"],
    [/\bITU[\s-]*K\.21\b/gi, "itu-k21"],
    [/\bUL[\s-]*1449\b/gi, "ul-1449"],
  ];
  for (const [re, tag] of iecPatterns) { if (re.test(text)) kw.push(tag); }

  // Component type keywords
  if (/\buni[\s-]*directional\b/i.test(text)) kw.push("unidirectional");
  if (/\bbi[\s-]*directional\b/i.test(text)) kw.push("bidirectional");
  if (/\bsurface\s*mount\b|\bSMD\b/i.test(text)) kw.push("smd");
  if (/\bthrough[\s-]*hole\b|\baxial\b|\bradial\b/i.test(text)) kw.push("through-hole");
  if (/\blow[\s-]*capacitance\b/i.test(text)) kw.push("low-capacitance");
  if (/\barray\b/i.test(text)) kw.push("array");

  return [...new Set(kw)];
}

// ── Optoelectronics extractors ──

function extractOptoProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  const isOptocoupler = /\boptocoupler\b|\bphototransistor\s*output\b|\bCTR\b|\bcurrent\s*transfer\s*ratio\b/i.test(text);
  const isPhotodiode = /\bphotodiode\b|\bdark\s*current\b|\bphoto\s*current\b|\bresponsivity\b/i.test(text);

  // ── Forward voltage VF — LEDs, IR emitters, optocoupler input ──
  // Inline: "VF 1.9 / 2.2 V", "VF = 3.3 V", tabular with spaces
  const vfRe = /V[Ff]\s*[:=]?\s*(\d+\.?\d*)\s*V/g;
  while ((m = vfRe.exec(text)) !== null) {
    const v = parseFloat(m[1]); if (v > 0 && v < 10) { props.push({ key: "vf", value: v, unit: "V", source }); break; }
  }
  if (!props.some((p) => p.key === "vf")) {
    // Tabular: "VF     1.9"
    const vfTab = /V[Ff]\s{4,}(\d+\.?\d*)/g;
    while ((m = vfTab.exec(text)) !== null) {
      const v = parseFloat(m[1]); if (v > 0 && v < 10) { props.push({ key: "vf", value: v, unit: "V", source }); break; }
    }
  }
  if (!props.some((p) => p.key === "vf")) {
    const vfP = scanSpecRow(text, /(?:Forward\s*Voltage|V[Ff]\b)/, (v) => v > 0 && v < 10, "vf", "V", source);
    if (vfP) props.push(vfP);
  }

  // ── Forward current IF (max continuous) ──
  // Inline first: "IF  20  mA" — symbol on its own line with value
  {
    const ifInline = /\bIF\b\s{2,}(\d+\.?\d*)\s*mA/g;
    while ((m = ifInline.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0 && v <= 5000) { props.push({ key: "if_max", value: v, unit: "mA", source }); break; }
    }
  }
  // Spec row: "Max Continuous Forward Current ... 20 mA" or "DC Forward Current ... 60 mA"
  if (!props.some((p) => p.key === "if_max")) {
    const ifP = scanSpecRow(text, /(?:(?:Max(?:imum)?\s*)?(?:Continuous\s*)?Forward\s*Current|DC\s*Forward\s*Current)\b/i,
      (v) => v > 0 && v <= 5000, "if_max", "mA", source);
    if (ifP) props.push(ifP);
  }
  // Chinese label scan: look for IF symbol line between Chinese labels
  if (!props.some((p) => p.key === "if_max")) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/正向.*电流|Forward\s*Current/i.test(lines[i]) && !/Peak|Pulse|脉冲/i.test(lines[i])) {
        for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 3); j++) {
          const ifm = lines[j].match(/\bIF[P]?\b\s+(\d+\.?\d*)/);
          if (ifm) {
            const v = parseFloat(ifm[1]);
            if (v > 0 && v <= 5000) { props.push({ key: "if_max", value: v, unit: "mA", source }); break; }
          }
        }
        if (props.some((p) => p.key === "if_max")) break;
      }
    }
  }

  // ── Wavelength — dominant (λd) or peak (λp) ──
  // Match "λd  615 / 630 nm", "λp  940 nm", "λP 390 ... 400 nm", "Peak Emission Wavelength ... 940 nm"
  const wlPatterns = [
    /[λλ]\s*[dD]\s*[:=]?\s*(\d{3,4})\s*(?:\/\s*(\d{3,4})\s*)?nm/g,
    /[λλ]\s*[pP]\s*[:=]?\s*(?:\/?\s*)?(\d{3,4})\s*(?:\/\s*(\d{3,4})\s*)?nm/gi,
    /(?:Dominant|Peak)\s*(?:Emission\s*)?Wave\s*[Ll]ength\s*(?:\([^)]*\))?\s*[:=]?\s*(?:\w+\s+)?(\d{3,4})\s*nm/gi,
    /[λλ][pPdD]\s{3,}(?:\/?\s*)?(\d{3,4})/g,
  ];
  for (const wlRe of wlPatterns) {
    if (props.some((p) => p.key === "wavelength_nm")) break;
    while ((m = wlRe.exec(text)) !== null) {
      const v1 = parseInt(m[1]);
      // If there's a second value (min/max range), average; otherwise take first
      const v2 = m[2] ? parseInt(m[2]) : null;
      const wl = v2 ? Math.round((v1 + v2) / 2) : v1;
      if (wl >= 100 && wl <= 1600) { props.push({ key: "wavelength_nm", value: wl, unit: "nm", source }); break; }
    }
  }
  // Fallback: "lP  Peak Emission Wavelength  IF = 20mA  940  nm"
  if (!props.some((p) => p.key === "wavelength_nm")) {
    const wlRow = scanSpecRow(text, /(?:Peak\s*(?:Emission\s*)?Wave\s*[Ll]ength|[λλ]\s*[pPdD])\b/,
      (v) => v >= 100 && v <= 1600, "wavelength_nm", "nm", source);
    if (wlRow) props.push(wlRow);
  }

  // ── Luminous intensity (mcd) — LEDs only (skip for photodiodes) ──
  if (!isPhotodiode) {
    const ivPatterns = [
      /(?:Luminous\s*(?:I|l)ntensity|I[Vv])\s*[:=]?\s*(\d+\.?\d*)\s*mcd/gi,
      /I[Vv]\s{3,}(\d+\.?\d*)\s*(?:\/\s*(\d+\.?\d*))?\s*mcd/g,
    ];
    for (const ivRe of ivPatterns) {
      if (props.some((p) => p.key === "luminous_intensity_mcd")) break;
      while ((m = ivRe.exec(text)) !== null) {
        const v = parseFloat(m[1]);
        if (v > 0 && v <= 100000) { props.push({ key: "luminous_intensity_mcd", value: v, unit: "mcd", source }); break; }
      }
    }
    if (!props.some((p) => p.key === "luminous_intensity_mcd")) {
      const ivP = scanSpecRow(text, /(?:Luminous\s*(?:I|l)ntensity|发光强度)/i,
        (v) => v > 0 && v <= 100000, "luminous_intensity_mcd", "mcd", source);
      if (ivP) props.push(ivP);
    }
  }

  // ── Radiant intensity (mW/sr) — IR LEDs only (skip for photodiodes) ──
  if (!isPhotodiode) {
    const rePatterns = [
      /(?:Radiant\s*Intensity|I[Ee])\s*[:=]?\s*(\d+\.?\d*)\s*m[Ww]\s*\/\s*sr/gi,
    ];
    for (const reRe of rePatterns) {
      if (props.some((p) => p.key === "radiant_intensity")) break;
      while ((m = reRe.exec(text)) !== null) {
        const v = parseFloat(m[1]);
        if (v > 0 && v <= 10000) { props.push({ key: "radiant_intensity", value: v, unit: "mW/sr", source }); break; }
      }
    }
    if (!props.some((p) => p.key === "radiant_intensity")) {
      const riP = scanSpecRow(text, /(?:Radiant\s*Intensity)/i,
        (v) => v > 0 && v <= 10000, "radiant_intensity", "mW/sr", source);
      if (riP) props.push(riP);
    }
  }

  // ── Viewing / half-intensity angle (degrees) ──
  // Match "2Ø1/2 120°", "2θ1/2 120", "Half Intensity Angle 20 deg", "Half Power View 120°"
  const anglePatterns = [
    /2\s*[Øθ]\s*1\s*\/\s*2\s*[:=]?\s*(?:\/?\s*)?(\d+\.?\d*)\s*°?/g,
    /(?:Half\s*(?:Intensity|Power)\s*(?:Angle|View)|Viewing\s*Angle|发光角度|半功率视角)\s*[:=]?\s*(?:\/?\s*)?(\d+\.?\d*)\s*°?/gi,
  ];
  for (const aRe of anglePatterns) {
    if (props.some((p) => p.key === "viewing_angle_deg")) break;
    while ((m = aRe.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0 && v <= 360) { props.push({ key: "viewing_angle_deg", value: v, unit: "deg", source }); break; }
    }
  }
  if (!props.some((p) => p.key === "viewing_angle_deg")) {
    const vaP = scanSpecRow(text, /(?:2\s*[Øθ]\s*1\s*\/\s*2|Half\s*(?:Intensity|Power)|Viewing\s*Angle|发光角度)/i,
      (v) => v > 0 && v <= 360, "viewing_angle_deg", "deg", source);
    if (vaP) props.push(vaP);
  }

  // ── Photodiode-specific properties ──
  if (isPhotodiode) {
    // Dark current (Id)
    const idPatterns = [
      /(?:dark\s*current|I[Dd])\s*[:=<≤]?\s*(\d+\.?\d*)\s*([nμµu]?)\s*A/gi,
    ];
    for (const idRe of idPatterns) {
      if (props.some((p) => p.key === "dark_current")) break;
      while ((m = idRe.exec(text)) !== null) {
        const prefix = m[2].toLowerCase();
        const mult = prefix === "n" ? 1e-9 : (prefix === "u" || prefix === "μ" || prefix === "µ") ? 1e-6 : 1;
        const val = parseFloat(m[1]) * mult;
        if (val >= 0 && val < 0.01) { props.push({ key: "dark_current", value: val, unit: "A", source }); break; }
      }
    }
    if (!props.some((p) => p.key === "dark_current")) {
      // Try to determine unit from context (nA vs μA)
      const dkP = scanSpecRow(text, /(?:dark\s*current|暗电流)/i,
        (v) => v >= 0 && v < 10000, "dark_current", "uA", source);
      if (dkP) props.push(dkP);
    }

    // Photo current (IL / Isc) — use strict patterns to avoid email false positives
    // First try inline: "IL  20  25  30  μA"
    {
      const ilInline = /\bIL\b\s{2,}(?:[\s\d.]+?)(\d+\.?\d*)\s*[μµu]?A/g;
      while ((m = ilInline.exec(text)) !== null) {
        const v = parseFloat(m[1]);
        if (v > 0 && v < 100000) { props.push({ key: "photo_current", value: v, unit: "uA", source }); break; }
      }
    }
    // Spec row fallback: match "Photo current" or Chinese, but NOT "光电流分" (binning header)
    if (!props.some((p) => p.key === "photo_current")) {
      const ilP = scanSpecRow(text, /(?:Photo\s*[Cc]urrent(?!\s*分)|(?:^|\s)光电流(?!分))/,
        (v) => v > 0 && v < 100000, "photo_current", "uA", source);
      if (ilP) props.push(ilP);
    }

    // Responsivity (A/W)
    const respRe = /(?:responsivity|sensitivity)\s*[:=]?\s*(\d+\.?\d*)\s*(?:m?)\s*A\s*\/\s*W/gi;
    while ((m = respRe.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0 && v <= 10000) { props.push({ key: "responsivity", value: v, unit: "A/W", source }); break; }
    }

    // Spectral range (sensitivity wave width) — "850 ... 1100 nm"
    // Inline pattern
    const specRangeRe = /(?:spectral|sensitivity|感光)\s*(?:range|width|波宽|范围)[^0-9]*?(\d{3,4})\s*(?:to|~|-|–|—|\.\.\.)?\s*(\d{3,4})\s*nm/gi;
    while ((m = specRangeRe.exec(text)) !== null) {
      const lo = parseInt(m[1]), hi = parseInt(m[2]);
      if (lo >= 100 && hi <= 2000 && hi > lo) {
        props.push({ key: "spectral_min_nm", value: lo, unit: "nm", source });
        props.push({ key: "spectral_max_nm", value: hi, unit: "nm", source });
        break;
      }
    }
    // Line scan: Chinese label may be on separate line from values
    if (!props.some((p) => p.key === "spectral_min_nm")) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/感光波宽|Sensitivity\s*wave|Spectral\s*(?:range|width)/i.test(lines[i])) continue;
        // Search surrounding lines (±3) for two 3-4 digit numbers that look like nm range
        for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 4); j++) {
          const rangeNums = [...lines[j].matchAll(/(\d{3,4})/g)].map(n => parseInt(n[1])).filter(v => v >= 100 && v <= 2000);
          if (rangeNums.length >= 2) {
            const lo = Math.min(...rangeNums), hi = Math.max(...rangeNums);
            if (hi > lo) {
              props.push({ key: "spectral_min_nm", value: lo, unit: "nm", source });
              props.push({ key: "spectral_max_nm", value: hi, unit: "nm", source });
              break;
            }
          }
        }
        if (props.some((p) => p.key === "spectral_min_nm")) break;
      }
    }
  }

  // ── Optocoupler-specific properties ──
  if (isOptocoupler) {
    // CTR (Current Transfer Ratio) — percentage
    // Try inline range first: "CTR: 50 ~ 150 %" or "50% to 150%"
    {
      const ctrRangeRe = /(?:Current\s*Transfer\s*Ratio|CTR)[^%\n]{0,60}?(\d+\.?\d*)\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*%/gi;
      while ((m = ctrRangeRe.exec(text)) !== null) {
        const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
        if (lo > 0 && hi > lo && hi <= 10000) {
          props.push({ key: "ctr_min_pct", value: lo, unit: "%", source });
          props.push({ key: "ctr_max_pct", value: hi, unit: "%", source });
          break;
        }
      }
    }
    // Line scan: find "CTR" at start of a spec table row, read min/max numbers + %
    if (!props.some((p) => p.key === "ctr_min_pct")) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        // CTR must appear at line start (with whitespace) followed by tabular data
        const ctrMatch = lines[i].match(/^\s{0,8}CTR\b/);
        if (!ctrMatch) continue;
        // Skip feature/prose lines
        if (/Minimizes|Groups|Normalized|Figure|vs\.|CTRRBE/i.test(lines[i])) continue;
        // Look for numbers followed by % on this line
        const afterCTR = lines[i].substring((ctrMatch.index ?? 0) + ctrMatch[0].length);
        const cleaned = afterCTR.replace(/[A-Z]{1,4}\s*=\s*-?\d+\.?\d*\s*[a-zA-Zμµ°℃]*/g, "");
        const nums = [...cleaned.matchAll(/(\d+\.?\d*)(?=\s)/g)].map(n => parseFloat(n[1])).filter(v => v > 0 && v <= 10000);
        if (nums.length >= 1) {
          props.push({ key: "ctr_min_pct", value: nums[0], unit: "%", source });
          if (nums.length >= 2) props.push({ key: "ctr_max_pct", value: nums[nums.length - 1], unit: "%", source });
          break;
        }
      }
    }
    // Table-based CTR
    if (!props.some((p) => p.key === "ctr_min_pct")) {
      const tableProps = scanTable(text, [
        { pattern: /\bCTR\b|Transfer\s*Ratio/i, key: "ctr_min_pct", unit: "%" },
      ], source);
      for (const tp of tableProps) {
        if (!props.some((p) => p.key === tp.key)) props.push(tp);
      }
    }

    // Isolation voltage (VISO / VIORM)
    const visoPatterns = [
      /(?:Isolation\s*Voltage|V\s*ISO|VISO)\s*[:=]?\s*(\d+\.?\d*)\s*V?\s*(?:AC\s*)?(?:RMS)?/gi,
      /(?:Working\s*Insulation\s*Voltage|VIORM)\s*[:=]?\s*(\d+\.?\d*)\s*V/gi,
    ];
    for (const visoRe of visoPatterns) {
      if (props.some((p) => p.key === "isolation_voltage")) break;
      while ((m = visoRe.exec(text)) !== null) {
        const v = parseFloat(m[1]);
        if (v >= 100 && v <= 20000) { props.push({ key: "isolation_voltage", value: v, unit: "V", source }); break; }
      }
    }
    if (!props.some((p) => p.key === "isolation_voltage")) {
      const visoP = scanSpecRow(text, /(?:Isolation\s*Voltage|V\s*ISO\b|VISO\b|VIORM\b|Input.*Output.*(?:Test\s*)?Voltage)/i,
        (v) => v >= 100 && v <= 20000, "isolation_voltage", "V", source);
      if (visoP) props.push(visoP);
    }

    // BVCEO (collector-emitter breakdown voltage)
    const bvceoP = scanSpecRow(text, /(?:BVCEO\b|Collector[\s-]*(?:to[\s-]*)?Emitter\s*(?:Breakdown\s*)?Voltage)/i,
      (v) => v >= 5 && v <= 10000, "bvceo", "V", source);
    if (bvceoP) props.push(bvceoP);
  }

  // ── Table-based fallback for all opto properties ──
  const tableProps = scanTable(text, [
    { pattern: /\bV[Ff]\b|Forward\s*Volt/i, key: "vf", unit: "V" },
    { pattern: /\bI[Vv]\b|Luminous\s*Intensity/i, key: "luminous_intensity_mcd", unit: "mcd" },
    { pattern: /[λλ]\s*[pPdD]\b|Wave\s*[Ll]ength/i, key: "wavelength_nm", unit: "nm" },
    { pattern: /2\s*[Øθ]\s*1\s*\/\s*2|Viewing|Half.*Angle/i, key: "viewing_angle_deg", unit: "deg" },
  ], source);
  const existing = new Set(props.map((p) => p.key));
  for (const tp of tableProps) { if (!existing.has(tp.key)) props.push(tp); }

  return props;
}

function extractOptoKeywords(text: string): string[] {
  const kw: string[] = [];

  // LED color names — match near LED/light/color context, not in random prose
  // Use the first 1500 chars (title/features section) for color matching
  const front = text.substring(0, Math.min(text.length, 1500));
  const colors: [RegExp, string][] = [
    [/\bred\b(?!\s*(?:appliance|wire|lead))/i, "red"],
    [/\bgreen\b(?!\s*(?:appliance|wire|lead))/i, "green"],
    [/\bblue\b/i, "blue"],
    [/\byellow\b/i, "yellow"], [/\borange\b/i, "orange"],
    [/\bwhite\b(?!\s*(?:appliance|goods|paper))/i, "white"],
    [/\bamber\b/i, "amber"], [/\bpurple\b/i, "purple"], [/\bpink\b/i, "pink"],
    [/\bcyan\b/i, "cyan"], [/\bwarm\s*white\b/i, "warm-white"],
    [/\bcool\s*white\b/i, "cool-white"], [/\bnatural\s*white\b/i, "natural-white"],
  ];
  for (const [re, name] of colors) { if (re.test(front)) kw.push(name); }

  // Chinese color names (common in Chinese datasheets)
  const cnColors: [RegExp, string][] = [
    [/红色|红光/, "red"], [/绿色|绿光/, "green"], [/蓝色|蓝光/, "blue"],
    [/黄色|黄光/, "yellow"], [/橙色|橙光/, "orange"],
    [/白色(?!家电)|白光/, "white"],  // exclude 白色家电 (white appliances)
    [/紫色|紫光/, "purple"], [/琥珀/, "amber"],
  ];
  for (const [re, name] of cnColors) { if (re.test(front) && !kw.includes(name)) kw.push(name); }

  // UV / IR type keywords — require proximity to LED/emitter/diode context,
  // not just application sections mentioning "infrared systems"
  if (/\bUV\b|\bultraviolet\b|紫外/i.test(front)) kw.push("uv");
  // For infrared, require it near emitting/LED/diode context OR in title/features, not just applications
  const irContext = /infrared\s*(?:led|emit|diode|light|receiver|sensor|remote)|IR\s*(?:LED|emitter|receiver)|红外(?:发射|接收|对管|LED)/i;
  const irTitle = /\binfrared\b/i.test(front.substring(0, 500));
  if (irContext.test(text) || irTitle) kw.push("infrared");

  // LED type/technology keywords
  if (/\bSMD\b|\bsurface\s*mount\b/i.test(text)) kw.push("smd");
  if (/\bthrough[\s-]?hole\b|\bTHT\b|\b5\s*mm\b|\b3\s*mm\b/i.test(text)) kw.push("through-hole");
  if (/\bCOB\b|chip[\s-]*on[\s-]*board/i.test(text)) kw.push("cob");
  if (/\bRGB\b/i.test(text)) kw.push("rgb");
  if (/\bhigh[\s-]?power\b/i.test(text)) kw.push("high-power");
  if (/\bhigh[\s-]?brightness\b/i.test(text)) kw.push("high-brightness");

  // Optocoupler keywords
  if (/\boptocoupler\b|\bphoto[\s-]?coupler\b|\bopto[\s-]?isolator\b/i.test(text)) kw.push("optocoupler");
  if (/\bphototransistor\b/i.test(text)) kw.push("phototransistor");

  // Photodiode keywords
  if (/\bphotodiode\b|\bphoto[\s-]?diode\b/i.test(text)) kw.push("photodiode");
  if (/\bPIN\s*(?:photo)?diode\b/i.test(text)) kw.push("pin-photodiode");
  if (/\bavalanche\b/i.test(text)) kw.push("avalanche");

  // Lens type
  if (/\bwater\s*clear\b|透明/i.test(text)) kw.push("water-clear");
  if (/\bdiffused\b|扩散/i.test(text)) kw.push("diffused");

  return [...new Set(kw)];
}

// ── Crystal / Oscillator / Resonator extractors ──

/**
 * Search for a ppm value near a label across multiple lines.
 * Crystal datasheets often have label on one line and value on the next,
 * with a leading row number that should be skipped.
 * Returns the number closest to a "ppm" marker, not leading row numbers.
 */
function findPpmNearLabel(text: string, labelRe: RegExp, skipRe?: RegExp): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    if (skipRe && skipRe.test(lines[i])) continue;
    // Search this line and the next 3 lines for "±N ppm" or "N ppm" patterns
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      const line = lines[j];
      // Prefer ±N ppm pattern (most common in crystal datasheets)
      const pmMatch = line.match(/[±+-]\s*(\d+\.?\d*)\s*ppm/i);
      if (pmMatch) {
        const val = parseFloat(pmMatch[1]);
        if (val > 0 && val <= 1000) return val;
      }
      // Also try: "N ppm" where N is preceded by whitespace (table value column)
      const spMatch = line.match(/\s(\d+\.?\d*)\s+ppm/i);
      if (spMatch) {
        const val = parseFloat(spMatch[1]);
        if (val > 0 && val <= 1000) return val;
      }
      // Also try: "NNppm" compact form
      const compMatch = line.match(/(\d+\.?\d*)ppm/i);
      if (compMatch) {
        const val = parseFloat(compMatch[1]);
        if (val > 0 && val <= 1000) return val;
      }
      // Handle "±30基准温度：25℃ ... ppm" — ± number with ppm elsewhere on same line
      if (/ppm/i.test(line)) {
        const pmAny = line.match(/[±+-]\s*(\d+\.?\d*)/);
        if (pmAny) {
          const val = parseFloat(pmAny[1]);
          if (val > 0 && val <= 1000) return val;
        }
      }
    }
  }
  return null;
}

/**
 * Search for a value near an Ohm unit marker, within lines matching a label.
 * Handles "40Ω max" on a different line from the label, skipping leading row numbers.
 */
function findOhmNearLabel(text: string, labelRe: RegExp): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    // Search this line and the next 3 lines
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      const line = lines[j];
      // Match "NΩ", "N Ω", "N Ohm" — anchor to the unit
      const ohmMatch = line.match(/(\d+\.?\d*)\s*(?:Ω|\u2126|Ohm|ohm)/i);
      if (ohmMatch) {
        const val = parseFloat(ohmMatch[1]);
        if (val > 0 && val <= 500) return val;
      }
    }
  }
  return null;
}

function extractCrystalProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // ── Nominal Frequency ──
  // "Nominal Frequency: 24.576000 MHz", "32.768KHz", "Frequency: 12.000000MHz"
  // Handle MH Z typo (space between H and Z), optional decimals
  const freqPatterns = [
    /(?:Nominal\s*Frequency|标称频率|Center\s*Frequency|中心频率)\s*[:：=]?\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*H?\s*[Zz]/gi,
    // Compact: "12.000MHZ", "32.768KHz", "4.000000 MH Z"
    /(\d+\.\d{2,})\s*(k|K|M|G)?\s*H\s*Z/gi,
    /(\d+\.\d{2,})\s*(k|K|M|G)?\s*Hz/gi,
    // "Frequency:" with separator — require colon/equals to avoid matching "Frequency Range"
    /(?:Frequency)\s*[:：=]\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*H?\s*[Zz]/gi,
  ];
  for (const freqRe of freqPatterns) {
    while ((m = freqRe.exec(text)) !== null) {
      const raw = parseFloat(m[1]);
      const prefix = (m[2] || "").toUpperCase();
      const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
      const freqHz = raw * mult;
      // Crystals/oscillators range from ~1 kHz to ~2 GHz
      if (freqHz >= 1000 && freqHz <= 2e9) {
        props.push({ key: "frequency", value: freqHz, unit: "Hz", source });
        break;
      }
    }
    if (props.some((p) => p.key === "frequency")) break;
  }

  // ── Load Capacitance (CL) ──
  // Use specific labels to avoid picking up test circuit values or output load
  const clPatterns = [
    /(?:Load\s*[Cc]apacita\s*n\s*c[eo]|负载电容)\s*(?:\([^)]*\))?\s*[:：=（(]?\s*(\d+\.?\d*)\s*pF/gi,
    // "CL" near pF value — require explicit separator
    /\bCL\s*[:：=（(]\s*(\d+\.?\d*)\s*pF/gi,
    // "12.000MHZ 15PF ±20PPM" pattern in title/description
    /[KkMG]?Hz\s+(\d+\.?\d*)\s*PF/gi,
  ];
  for (const clRe of clPatterns) {
    while ((m = clRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 1 && val <= 100) { props.push({ key: "load_capacitance", value: val, unit: "pF", source }); break; }
    }
    if (props.some((p) => p.key === "load_capacitance")) break;
  }
  // Fallback: line-based search for "Load capacitance" label with pF on nearby lines
  if (!props.some((p) => p.key === "load_capacitance")) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/Load\s*[Cc]apacita|负载电容/i.test(lines[i])) continue;
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const pfMatch = lines[j].match(/(\d+\.?\d*)\s+pF/i);
        if (pfMatch) {
          const val = parseFloat(pfMatch[1]);
          if (val >= 1 && val <= 100) { props.push({ key: "load_capacitance", value: val, unit: "pF", source }); break; }
        }
      }
      if (props.some((p) => p.key === "load_capacitance")) break;
    }
  }

  // ── Frequency Tolerance (ppm at 25C) ──
  // Use line-based ppm search to avoid scanSpecRow row-number false positives
  const tolVal = findPpmNearLabel(text, /(?:Frequency\s*Tolerance|调整频差|常温频差)/i);
  if (tolVal !== null) props.push({ key: "freq_tolerance", value: tolVal, unit: "ppm", source });
  // Fallback: inline "±20PPM" pattern (compact, e.g. in title lines)
  if (!props.some((p) => p.key === "freq_tolerance")) {
    const tolInline = text.match(/[±]\s*(\d+\.?\d*)\s*PPM/);
    if (tolInline) {
      const val = parseFloat(tolInline[1]);
      if (val > 0 && val <= 1000) props.push({ key: "freq_tolerance", value: val, unit: "ppm", source });
    }
  }

  // ── Frequency Stability (ppm over temp range) ──
  // Skip "频率牵引范围" (frequency pulling), "初始频率精度" (initial accuracy), aging
  const stabVal = findPpmNearLabel(text,
    /(?:Frequency\s*Stability|频率(?:温度)?稳定[度性]|温度频差|Stability\s*over|Overall\s*Freq(?:uency)?\.?\s*Stability)/i,
    /牵引|pulling|精度|accuracy|aging|老化|incl\.\s*25/i);
  if (stabVal !== null) props.push({ key: "freq_stability", value: stabVal, unit: "ppm", source });

  // ── ESR / Equivalent Series Resistance / Motional Resistance ──
  // Use Ohm-anchored search to avoid row-number false positives
  const esrLabelRe = /(?:Equivalent\s*(?:Series\s*)?Resistance|谐振电阻|Motional\s*Resistance|谐振阻抗)/i;
  const esrVal = findOhmNearLabel(text, esrLabelRe);
  if (esrVal !== null) props.push({ key: "esr", value: esrVal, unit: "Ohm", source });
  // Fallback: inline "<50Ω" pattern
  if (!props.some((p) => p.key === "esr")) {
    const esrInline = text.match(/(?:Equivalent\s*(?:Series\s*)?Resistance|谐振电阻|谐振阻抗|ESR)\s*[:：=<≤]?\s*(?:[<≤]\s*)?(\d+\.?\d*)\s*(?:Ω|\u2126|Ohm|ohm)/i);
    if (esrInline) {
      const val = parseFloat(esrInline[1]);
      if (val > 0 && val <= 500) props.push({ key: "esr", value: val, unit: "Ohm", source });
    }
  }

  // ── Supply Voltage (oscillators/TCXOs) ──
  const vsupPatterns = [
    /(?:Input\s*Voltage|Supply\s*Voltage|VDD)\s*[:：=（(]?\s*\+?\s*(\d+\.?\d*)\s*V/gi,
    /(\d+\.?\d*)\s*Vdc/gi,
  ];
  for (const vsupRe of vsupPatterns) {
    while ((m = vsupRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 1 && val <= 7) { props.push({ key: "supply_voltage", value: val, unit: "V", source }); break; }
    }
    if (props.some((p) => p.key === "supply_voltage")) break;
  }

  // ── Shunt Capacitance (C0) ──
  // Must match "N pF" close to label, avoid percentage and row-number false positives
  const c0Patterns = [
    /(?:Shunt\s*Capacitance|静[态电]容)\s*(?:\([^)]*\))?\s*[:：=<≤]?\s*(?:≤\s*)?(\d+\.?\d*)\s*pF/gi,
  ];
  for (const c0Re of c0Patterns) {
    while ((m = c0Re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 20) { props.push({ key: "shunt_capacitance", value: val, unit: "pF", source }); break; }
    }
    if (props.some((p) => p.key === "shunt_capacitance")) break;
  }
  // Fallback: line-based search for label with pF on nearby lines
  if (!props.some((p) => p.key === "shunt_capacitance")) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/Shunt\s*Capacitance|静[态电]容/i.test(lines[i])) continue;
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const pfMatch = lines[j].match(/(\d+\.?\d*)\s*pF/i);
        if (pfMatch) {
          const val = parseFloat(pfMatch[1]);
          if (val > 0 && val <= 20) { props.push({ key: "shunt_capacitance", value: val, unit: "pF", source }); break; }
        }
      }
      if (props.some((p) => p.key === "shunt_capacitance")) break;
    }
  }

  // ── Drive Level ──
  const dlPatterns = [
    /(?:Drive\s*Level|激励功率)\s*[:：=<≤]?\s*(?:≤\s*)?(\d+\.?\d*)\s*(?:µ|μ|u)?\s*[Ww]/gi,
  ];
  for (const dlRe of dlPatterns) {
    while ((m = dlRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 10000) { props.push({ key: "drive_level", value: val, unit: "uW", source }); break; }
    }
    if (props.some((p) => p.key === "drive_level")) break;
  }

  return props;
}

function extractCrystalKeywords(text: string): string[] {
  const kw: string[] = [];

  // Output waveform type
  if (/\bCMOS\b/i.test(text)) kw.push("CMOS");
  if (/\b(?:clipped[\s-]?)?sine\s*wave\b|正弦波/i.test(text)) kw.push("sine-wave");
  if (/\bLVPECL\b/i.test(text)) kw.push("LVPECL");
  if (/\bLVDS\b/i.test(text)) kw.push("LVDS");
  if (/\bHCSL\b/i.test(text)) kw.push("HCSL");

  // Oscillation mode
  if (/\bFundamental\b|基频/i.test(text)) kw.push("fundamental");
  if (/\b(?:3rd\s*)?overtone\b/i.test(text)) kw.push("overtone");

  // Oscillator type keywords
  if (/\bTCXO\b|温补晶振/i.test(text)) kw.push("TCXO");
  if (/\bVCXO\b/i.test(text)) kw.push("VCXO");
  if (/\bOCXO\b/i.test(text)) kw.push("OCXO");
  if (/\bMEMS\b/i.test(text)) kw.push("MEMS");
  if (/\bSAW\b/.test(text)) kw.push("SAW");
  if (/\bprogrammable\b/i.test(text)) kw.push("programmable");

  // Package / construction
  if (/\bglass[\s-]*seal/i.test(text)) kw.push("glass-sealed");
  if (/\bhermetic/i.test(text)) kw.push("hermetic");

  // Voltage control
  if (/\bvoltage[\s-]*control|电压控制/i.test(text)) kw.push("voltage-controlled");

  // Low phase noise
  if (/\blow[\s-]*phase[\s-]*noise|低相噪/i.test(text)) kw.push("low-phase-noise");

  // Spread spectrum
  if (/\bspread[\s-]*spectrum\b/i.test(text)) kw.push("spread-spectrum");

  return [...new Set(kw)];
}

// ── Sensor extractors ──

function extractSensorProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // Detect sub-type from text content
  const isNTC = /\bNTC\b|negative\s*temperature\s*coefficient/i.test(text);
  const isPTC = /\bPTC\b(?!.*fuse)|positive\s*temperature\s*coefficient/i.test(text);
  const isThermistor = isNTC || isPTC || /\bthermistor\b/i.test(text);
  const isPressure = /\bpressure\s*(?:sensor|transducer)\b|压力传感器|\bbarometric\b|\bbarometer\b/i.test(text);
  const isHall = /\bhall\b|霍尔/i.test(text);
  const isCurrentSensor = /\bcurrent\s*sensor\b|电流传感器|\bcurrent\s*detect/i.test(text);
  const isTempSensor = /\btemperature\s*sensor\b|温度传感器|\btemp[\s-]*monitor\b/i.test(text) && !isThermistor;
  const isLight = /\blight\s*sensor\b|ambient\s*light\b|\bphoto(?:diode|transistor|resistor|sensor)\b|\blux\b|照度/i.test(text);
  const isHumidity = /\bhumidity\b|湿度/i.test(text);
  const isAccelerometer = /\baccelerometer\b|加速度/i.test(text);
  const isGyro = /\bgyroscope\b|\bgyro\b|陀螺仪/i.test(text);
  const isIMU = /\bIMU\b|inertial\s*measurement/i.test(text);

  // ── NTC/PTC Thermistor properties ──
  if (isThermistor) {
    // Resistance at 25°C (R25) — "R25 = 10kΩ", "10,000 Ω", "10kΩ @25°C"
    const r25Patterns = [
      /R\s*25\s*[:=]?\s*(\d+(?:[,.]?\d+)*)\s*(k|K|M)?\s*(?:Ω|\u2126|Ohm|ohm)/gi,
      /(?:Resistance|resistance)\s*(?:value\s*)?\[?\s*25\s*[°˚]?\s*C?\s*\]?\s*[:=]?\s*(\d+(?:[,.]?\d+)*)\s*(k|K|M)?\s*(?:Ω|\u2126|Ohm|ohm)/gi,
      /(\d+(?:[,.]?\d+)*)\s*(k|K|M)?\s*(?:Ω|\u2126|Ohm|ohm)\s*@?\s*25\s*[°˚]?\s*C/gi,
      /(\d+(?:[,.]?\d+)*)\s*(k|K|M)?\s*(?:Ω|\u2126|Ohm|ohm).*?\bat\s*25\s*[°˚]?\s*C/gi,
    ];
    for (const re of r25Patterns) {
      while ((m = re.exec(text)) !== null) {
        const raw = m[1].replace(/,/g, "");
        const val = parseFloat(raw);
        const prefix = m[2];
        const mult = (prefix === "k" || prefix === "K") ? 1e3 : prefix === "M" ? 1e6 : 1;
        const ohms = val * mult;
        if (ohms > 0 && ohms <= 1e7) {
          props.push({ key: "r25", value: ohms, unit: "Ohm", source });
          break;
        }
      }
      if (props.some((p) => p.key === "r25")) break;
    }

    // B constant / B-value — "B25/85 = 3380K", "B constant: 3435", "B value 4250K"
    // Require word boundary before B to avoid matching "2B 2051" table entries
    const bPatterns = [
      /\bB\s*(?:constant|value|25\s*\/\s*\d+)\s*[:=]?\s*(\d{3,5})\s*K?\b/gi,
      /\bB\s*\(\s*25\s*\/\s*\d+\s*\)\s*[:=]?\s*(\d{3,5})\s*K?\b/gi,
    ];
    for (const re of bPatterns) {
      while ((m = re.exec(text)) !== null) {
        const val = parseInt(m[1]);
        if (val >= 1000 && val <= 10000) {
          props.push({ key: "b_constant", value: val, unit: "K", source });
          break;
        }
      }
      if (props.some((p) => p.key === "b_constant")) break;
    }

    // Table-based B constant — NTC catalog datasheets with "B constant" column headers
    // Require "Part No" or "Resistance" on the header line to identify data tables (not legends)
    if (!props.some((p) => p.key === "b_constant")) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/B\s*constant/i.test(lines[i]) || !/Part\s*No/i.test(lines[i])) continue;
        const headerBlock = lines.slice(i, Math.min(i + 6, lines.length)).join(" ");
        if (!/\(K\)/i.test(headerBlock)) continue;
        // Found a data table header; scan subsequent rows for 4-digit B constants
        for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
          if (lines[j].trim().length < 30) continue;
          const nums = [...lines[j].matchAll(/\b(\d{4})\b/g)];
          for (const nm of nums) {
            const val = parseInt(nm[1]);
            if (val >= 2000 && val <= 6000) {
              props.push({ key: "b_constant", value: val, unit: "K", source });
              break;
            }
          }
          if (props.some((p) => p.key === "b_constant")) break;
        }
        if (props.some((p) => p.key === "b_constant")) break;
      }
    }

    // Resistance tolerance — "±1%", "Resistance tolerance ±5%"
    const tolRe = /(?:resistance\s*)?tolerance\s*[:=]?\s*[±+-]\s*(\d+(?:\.\d+)?)\s*%/gi;
    while ((m = tolRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 20) { props.push({ key: "tolerance_pct", value: val, unit: "%", source }); break; }
    }

    // Max power — "Max. power: 100mW", "Maximum rated power: 200 mW"
    const pwrP = scanSpecRow(text, /(?:Max(?:imum)?\s*(?:rated\s*)?power|Rated\s*power|额定功率)/i,
      (v) => v > 0 && v < 10000, "max_power", "mW", source);
    if (pwrP) props.push(pwrP);

    // Dissipation factor — "Dissipation factor: 15 mW/K"
    const dfP = scanSpecRow(text, /(?:Dissipation\s*factor[s]?|耗散系数)/i,
      (v) => v > 0 && v < 100, "dissipation_factor", "mW/K", source);
    if (dfP) props.push(dfP);
  }

  // ── Temperature sensor properties (digital IC type) ──
  if (isTempSensor) {
    // Accuracy — "±1°C", "±0.25°C", "accuracy: ±0.5°C"
    const accPatterns = [
      /(?:accuracy|error|精度)\s*[:=]?\s*[±]\s*(\d+\.?\d*)\s*[°˚]?\s*C/gi,
      /[±]\s*(\d+\.?\d*)\s*[°˚]?\s*C\s*(?:accuracy|typical|max)/gi,
    ];
    const accCandidates: number[] = [];
    for (const re of accPatterns) {
      while ((m = re.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        if (val > 0 && val <= 10) accCandidates.push(val);
      }
    }
    // Also scan feature lines: "±1°C REMOTE DIODE SENSOR"
    const featAccRe = /[±]\s*(\d+\.?\d*)\s*[°˚]?\s*C\b/g;
    const firstLines = text.substring(0, 3000);
    while ((m = featAccRe.exec(firstLines)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 10) accCandidates.push(val);
    }
    if (accCandidates.length > 0) {
      props.push({ key: "accuracy", value: Math.min(...accCandidates), unit: "C", source });
    }

    // Resolution — "12-bit", "16-bit resolution"
    const resRe = /(\d{1,2})\s*-?\s*bit\s*(?:resolution)?/gi;
    while ((m = resRe.exec(text)) !== null) {
      const val = parseInt(m[1]);
      if (val >= 8 && val <= 24) { props.push({ key: "resolution", value: val, unit: "bit", source }); break; }
    }
  }

  // ── Pressure sensor properties ──
  if (isPressure) {
    // Pressure range — "0~1000kPa", "-100kPa", "0 to 10 bar", "0~150psi"
    const pressPatterns = [
      /(?:range|量程|测量范围|pressure\s*range)?\s*(?:[:=]?\s*)?(?:-?\d+\.?\d*\s*(?:to|~|\.{2,3})\s*)?(\d+\.?\d*)\s*(kPa|MPa|bar|psi|atm)/gi,
      /(\d+\.?\d*)\s*(kPa|MPa|bar|psi|atm)\s*(?:gauge|absolute|full\s*scale)/gi,
    ];
    let bestPressure = 0;
    for (const re of pressPatterns) {
      while ((m = re.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        const unit = m[2];
        if (val > 0) {
          const kpa = unit === "MPa" ? val * 1000 : unit === "bar" ? val * 100 :
            unit === "psi" ? val * 6.895 : unit === "atm" ? val * 101.325 : val;
          if (kpa > bestPressure) bestPressure = kpa;
        }
      }
    }
    if (bestPressure > 0) props.push({ key: "pressure_max", value: bestPressure, unit: "kPa", source });

    // Accuracy — "±1%Span", "±0.5%FS", "精度: ±1 %"
    const pAccRe = /(?:accuracy|精度)\s*[:=]?\s*[±]\s*(\d+\.?\d*)\s*%/gi;
    while ((m = pAccRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 10) { props.push({ key: "accuracy_pct", value: val, unit: "%", source }); break; }
    }
  }

  // ── Hall sensor properties ──
  if (isHall && !isCurrentSensor) {
    // Sensitivity — "sensitivity: 30 mV/G", "XX mV/Gauss"
    const sensMvG = /(?:sensitivity|灵敏度)\s*[:=]?\s*(\d+\.?\d*)\s*mV\s*\/\s*(?:G|Gauss|mT)/gi;
    while ((m = sensMvG.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val < 10000) { props.push({ key: "sensitivity", value: val, unit: "mV/G", source }); break; }
    }

    // Operate point (BOP) — "BOP: ±30 Gauss", "开启点: ±50 GS"
    const bopRe = /(?:B\s*OP|operate?\s*point|开启点)\s*[:=]?\s*[±+-]?\s*(\d+\.?\d*)\s*(?:Gauss|GS|G|mT)/gi;
    while ((m = bopRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val < 1000) { props.push({ key: "bop", value: val, unit: "Gauss", source }); break; }
    }
    if (!props.some((p) => p.key === "bop")) {
      const bopP = scanSpecRow(text, /(?:B\s*OP|Operate?\s*Point|开启点|工作点)/i,
        (v) => v > 0 && v < 1000, "bop", "Gauss", source);
      if (bopP) props.push(bopP);
    }

    // Release point (BRP)
    const brpP = scanSpecRow(text, /(?:B\s*RP|Release\s*Point|释放点|闭合点)/i,
      (v) => v > 0 && v < 1000, "brp", "Gauss", source);
    if (brpP) props.push(brpP);
  }

  // ── Current sensor properties ──
  if (isCurrentSensor) {
    // Sensitivity — "sensitivity: 100 mV/A", "灵敏度: 66.7 mV/A", "SNST ... 100 mV/A"
    const csensRe = /(?:sensitivity|灵敏度|SNST)\s*[:=]?\s*(?:-?\d+\.?\d*\s*A?\s*[≤<]?\s*IP\s*[≤<]?\s*\d+\.?\d*\s*A?\s*)?(\d+\.?\d*)\s*mV\s*\/\s*A/gi;
    while ((m = csensRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val < 10000) { props.push({ key: "sensitivity", value: val, unit: "mV/A", source }); break; }
    }
    // Table scan: look for "灵敏度(mV/A)" or "sensitivity" column headers
    if (!props.some((p) => p.key === "sensitivity")) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        // Match sensitivity spec row: "SNST  灵敏度  ...  NNN  ...  mV/A"
        if (/\bSNST\b/.test(lines[i]) && /mV\s*\/\s*A/.test(lines[i]) && !/DRIFT|ERAT|error|误差|match|匹配/i.test(lines[i])) {
          const nums = [...lines[i].matchAll(/(\d+\.?\d*)/g)];
          for (const nm of nums) {
            const val = parseFloat(nm[1]);
            if (val >= 1 && val <= 2000) { props.push({ key: "sensitivity", value: val, unit: "mV/A", source }); break; }
          }
          if (props.some((p) => p.key === "sensitivity")) break;
        }
        // Match selection guide table: "灵敏度(mV/A)" header
        if (/灵敏度\s*\(\s*mV\s*\/\s*A\s*\)|sensitivity\s*\(\s*mV\s*\/\s*A\s*\)/i.test(lines[i])) {
          // Read next data rows
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            const nums = [...lines[j].matchAll(/(\d+\.?\d*)/g)];
            for (const nm of nums) {
              const val = parseFloat(nm[1]);
              if (val >= 1 && val <= 2000) { props.push({ key: "sensitivity", value: val, unit: "mV/A", source }); break; }
            }
            if (props.some((p) => p.key === "sensitivity")) break;
          }
          if (props.some((p) => p.key === "sensitivity")) break;
        }
      }
    }
    if (!props.some((p) => p.key === "sensitivity")) {
      const sensP = scanSpecRow(text, /(?:Sensitivity|灵敏度)\b(?!.*(?:error|误差|drift|漂移|match|匹配))/i,
        (v) => v > 0 && v < 10000, "sensitivity", "mV/A", source);
      if (sensP) props.push(sensP);
    }

    // Current range — "±20A", "输入电流范围: ±80A", "IPR: -20 to 20A"
    const crangeRe = /(?:current\s*range|输入电流范围|IPR|检测范围)\s*[:=]?\s*[±+-]?\s*(\d+\.?\d*)\s*A\b/gi;
    while ((m = crangeRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 1000) { props.push({ key: "current_range", value: val, unit: "A", source }); break; }
    }

    // Bandwidth — "bandwidth: 250 kHz", "BW: 120 kHz", "带宽: 250 kHz"
    const bwRe = /(?:bandwidth|BW|带宽)\s*[:=]?\s*(?:–?\d+\s*dB\s*;?\s*)?(\d+\.?\d*)\s*(k|M)?\s*Hz/gi;
    while ((m = bwRe.exec(text)) !== null) {
      const mult = m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0) { props.push({ key: "bandwidth", value: val, unit: "Hz", source }); break; }
    }

    // Isolation voltage — "isolation: 4800 Vrms", "隔离电压: 4.8kV"
    const isoRe = /(?:isolation|隔离.*电压|VISO)\s*[:=]?\s*(\d+\.?\d*)\s*(k)?\s*V\s*(?:rms)?/gi;
    while ((m = isoRe.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "k" ? 1000 : 1);
      if (val >= 100) { props.push({ key: "isolation_voltage", value: val, unit: "V", source }); break; }
    }
  }

  // ── Ambient light sensor properties ──
  if (isLight) {
    // Lux range — "0 to 65535 lux", "range: 100000 lux"
    const luxRe = /(\d+(?:,\d+)*)\s*(?:lux|Lux|lx)\b/gi;
    let maxLux = 0;
    while ((m = luxRe.exec(text)) !== null) {
      const val = parseInt(m[1].replace(/,/g, ""));
      if (val > maxLux) maxLux = val;
    }
    if (maxLux > 0) props.push({ key: "lux_max", value: maxLux, unit: "lux", source });

    // Resolution in bits
    const lResRe = /(\d{1,2})\s*-?\s*bit\s*(?:resolution|ADC)?/gi;
    while ((m = lResRe.exec(text)) !== null) {
      const val = parseInt(m[1]);
      if (val >= 8 && val <= 24) { props.push({ key: "resolution", value: val, unit: "bit", source }); break; }
    }
  }

  // ── Humidity sensor properties ──
  if (isHumidity) {
    // RH accuracy — "±2%RH", "accuracy: ±3 %RH"
    const rhAccRe = /[±]\s*(\d+\.?\d*)\s*%\s*RH/gi;
    const rhCandidates: number[] = [];
    while ((m = rhAccRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 20) rhCandidates.push(val);
    }
    if (rhCandidates.length > 0) {
      props.push({ key: "rh_accuracy", value: Math.min(...rhCandidates), unit: "%RH", source });
    }
  }

  // ── Accelerometer / Gyro / IMU properties ──
  if (isAccelerometer || isIMU) {
    // G range — "±2g/±4g/±8g/±16g", "measurement range: ±200g"
    const gRangeRe = /[±]\s*(\d+)\s*g\b/g;
    let maxG = 0;
    while ((m = gRangeRe.exec(text)) !== null) {
      const val = parseInt(m[1]);
      if (val >= 1 && val <= 10000 && val > maxG) maxG = val;
    }
    if (maxG > 0) props.push({ key: "g_range", value: maxG, unit: "g", source });

    // Sensitivity — "sensitivity: 0.4 mV/g" or "1 mg/LSB"
    const accelSensRe = /(?:sensitivity)\s*[:=]?\s*(\d+\.?\d*)\s*(m)?V\s*\/\s*g/gi;
    while ((m = accelSensRe.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
      if (val > 0) { props.push({ key: "sensitivity", value: val, unit: "V/g", source }); break; }
    }
  }

  if (isGyro || isIMU) {
    // DPS range — "±250/±500/±1000/±2000 dps"
    const dpsRe = /[±]\s*(\d+)\s*(?:dps|°\/s)/gi;
    let maxDps = 0;
    while ((m = dpsRe.exec(text)) !== null) {
      const val = parseInt(m[1]);
      if (val > maxDps) maxDps = val;
    }
    if (maxDps > 0) props.push({ key: "dps_range", value: maxDps, unit: "dps", source });
  }

  // ── Common sensor properties: supply voltage ──
  const vsupRe = /V[CcDdSs][CcDdSs]?\s*[:=]?\s*(\d+\.?\d*)\s*V?\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*V/g;
  let bestMin = Infinity, bestMax = 0;
  while ((m = vsupRe.exec(text)) !== null) {
    const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
    if (hi > lo && hi < 100 && (hi - lo) > (bestMax - bestMin)) { bestMin = lo; bestMax = hi; }
  }
  const altRe = /(\d+\.?\d*)\s*V?\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*V/g;
  const featLines = text.split("\n").slice(0, 80);
  for (const line of featLines) {
    if (!/(?:supply|operating|power|电源|工作|供电)\s*(?:voltage|电压)?/i.test(line)) continue;
    while ((m = altRe.exec(line)) !== null) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (lo >= 0.5 && hi <= 60 && hi > lo && (hi - lo) > (bestMax - bestMin)) { bestMin = lo; bestMax = hi; }
    }
  }
  if (bestMax > bestMin && bestMax < 100) {
    props.push({ key: "vcc_min", value: bestMin, unit: "V", source });
    props.push({ key: "vcc_max", value: bestMax, unit: "V", source });
  }

  // ── Common sensor properties: quiescent/supply current ──
  if (!isThermistor) {
    const iqPatterns = [
      /(?:I[QqCcDd][CcDdQq]?|quiescent\s*current|supply\s*current|消耗电流|工作电流|电源电流)\s*[:=]?\s*(\d+\.?\d*)\s*([uμµ]|m)?\s*A/gi,
      /(?:average|平均)\s*(?:current|电流)?\s*[:=]?\s*(?:only\s*)?(\d+\.?\d*)\s*([uμµ]|m)?\s*A/gi,
    ];
    for (const re of iqPatterns) {
      while ((m = re.exec(text)) !== null) {
        const mult = (m[2] === "u" || m[2] === "μ" || m[2] === "µ") ? 1e-6 : m[2] === "m" ? 1e-3 : 1;
        const val = parseFloat(m[1]) * mult;
        if (val > 0 && val < 1) { props.push({ key: "iq", value: val, unit: "A", source }); break; }
      }
      if (props.some((p) => p.key === "iq")) break;
    }
  }

  return props;
}

function extractSensorKeywords(text: string): string[] {
  const kw: string[] = [];

  // Sensor type keywords
  if (/\bNTC\b/i.test(text)) kw.push("ntc");
  if (/\bPTC\b(?!.*fuse)/i.test(text)) kw.push("ptc");
  if (/\bthermistor\b/i.test(text)) kw.push("thermistor");
  if (/\bhall\b|霍尔/i.test(text)) kw.push("hall");
  if (/\bcurrent\s*sensor\b|电流传感器/i.test(text)) kw.push("current-sensor");
  if (/\baccelerometer\b|加速度/i.test(text)) kw.push("accelerometer");
  if (/\bgyroscope\b|\bgyro\b|陀螺仪/i.test(text)) kw.push("gyroscope");
  if (/\bIMU\b|inertial\s*measurement/i.test(text)) kw.push("imu");
  if (/\bmagnetometer\b|地磁/i.test(text)) kw.push("magnetometer");
  if (/\bbarometer\b|\bbarometric\b/i.test(text)) kw.push("barometer");
  if (/\bpressure\s*sensor\b|压力传感器/i.test(text)) kw.push("pressure-sensor");
  if (/\bhumidity\b|湿度/i.test(text)) kw.push("humidity");
  if (/\bambient\s*light\b|\bALS\b/i.test(text)) kw.push("ambient-light");
  if (/\bproximity\s*(?:sensor|detect)/i.test(text)) kw.push("proximity");
  if (/\btouch\s*sensor\b|触摸/i.test(text)) kw.push("touch");
  if (/\bphoto(?:resistor|diode)\b/i.test(text)) kw.push("photosensor");
  if (/\binfrared\b|\bIR\s*sensor\b|红外/i.test(text)) kw.push("infrared");

  // Interface keywords
  if (/\bI2C\b|\bI²C\b|SMBus/i.test(text)) kw.push("i2c");
  if (/\bSPI\b/g.test(text)) kw.push("spi");
  if (/\banalog\s*output\b|模拟输出/i.test(text)) kw.push("analog-output");
  if (/\bdigital\s*output\b|数字输出/i.test(text)) kw.push("digital-output");
  if (/\bpush[\s-]*pull\b|推挽/i.test(text)) kw.push("push-pull");
  if (/\bopen[\s-]*drain\b|开漏/i.test(text)) kw.push("open-drain");
  if (/\b1[\s-]?wire\b|one[\s-]?wire\b/i.test(text)) kw.push("1-wire");

  // Sensing polarity for Hall sensors
  if (/\bomni[\s-]*polar\b|\ball[\s-]*polar\b|全极性/i.test(text)) kw.push("omnipolar");
  if (/\buni[\s-]*polar\b|单极性/i.test(text)) kw.push("unipolar");
  if (/\blatching\s*(?:hall|output|mode|switch)\b|锁存(?:型|输出)/i.test(text)) kw.push("latching");

  // Special features
  if (/\blow[\s-]*power\b|低功耗|micro[\s-]*power/i.test(text)) kw.push("low-power");
  if (/\bratiometric\b|比例/i.test(text)) kw.push("ratiometric");
  if (/\bdifferential\b|差分/i.test(text)) kw.push("differential");
  if (/\bisolat(?:ed|ion)\b|隔离/i.test(text)) kw.push("isolated");
  if (/\bMEMS\b/i.test(text)) kw.push("mems");
  if (/\bwaterproof\b|防水/i.test(text)) kw.push("waterproof");

  return [...new Set(kw)];
}

// ── Switch extractors ──

function extractSwitchProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // Contact rating current — "25mA", "50mA@12V", "3A 250VAC", "switching 25mA, 24VDC"
  const contactCurrentPatterns = [
    /(?:contact\s*rating|rated\s*(?:load|current)|switching)\s*[:：=]?\s*(\d+\.?\d*)\s*(m?)\s*A/gi,
    /(\d+\.?\d*)\s*(m?)\s*A\s*[,/]\s*\d+\s*V/gi,
    /(\d+\.?\d*)\s*(m?)\s*A\s*@\s*\d+\s*V/gi,
  ];
  for (const re of contactCurrentPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
      if (val > 0 && val <= 30) { props.push({ key: "contact_rating_current", value: val, unit: "A", source }); break; }
    }
    if (props.some((p) => p.key === "contact_rating_current")) break;
  }

  // Contact rating voltage — "24VDC", "250VAC", "12V DC"
  const contactVoltagePatterns = [
    /(?:contact\s*rating|rated\s*(?:load|voltage)|switching)\s*[:：=]?\s*(?:\d+\.?\d*\s*m?A\s*[,/@]\s*)?(\d+)\s*V\s*(?:AC|DC)?/gi,
    /(\d+)\s*V\s*(?:AC|DC)\b/gi,
  ];
  for (const re of contactVoltagePatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseInt(m[1]);
      if (val > 0 && val <= 500) { props.push({ key: "contact_rating_voltage", value: val, unit: "V", source }); break; }
    }
    if (props.some((p) => p.key === "contact_rating_voltage")) break;
  }

  // Contact resistance — "100mΩ Max.", "80mΩ max", "Contact Resistance: 100mΩ"
  const crPatterns = [
    /(?:contact\s*resistance|接触电阻)\s*[:：=<≤]?\s*(\d+\.?\d*)\s*(m?)\s*(?:Ω|\u2126|Ohm|ohm)/gi,
    /(\d+\.?\d*)\s*(m?)\s*(?:Ω|\u2126|Ohm|ohm)\s*(?:Max|max|Initial)/gi,
  ];
  for (const re of crPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
      if (val > 0 && val < 10) { props.push({ key: "contact_resistance", value: val, unit: "Ohm", source }); break; }
    }
    if (props.some((p) => p.key === "contact_resistance")) break;
  }
  // Fallback: scanSpecRow for multiline "Contact\nResistance ... 80mΩ"
  if (!props.some((p) => p.key === "contact_resistance")) {
    // Look for lines containing both "Resistance" and mΩ near "Contact"
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/Contact/i.test(lines[i]) && !/Contact/i.test(lines[Math.max(0, i-1)])) continue;
      // Check current and surrounding lines for "NmΩ" pattern
      for (let j = Math.max(0, i-1); j < Math.min(lines.length, i+3); j++) {
        const crm = lines[j].match(/(\d+\.?\d*)\s*m\s*(?:Ω|\u2126|Ohm|ohm)/i);
        if (crm) {
          const val = parseFloat(crm[1]) * 0.001;
          if (val > 0 && val < 1) { props.push({ key: "contact_resistance", value: val, unit: "Ohm", source }); break; }
        }
      }
      if (props.some((p) => p.key === "contact_resistance")) break;
    }
  }

  // Insulation resistance — "500MΩ Min.", "100MΩ min", "1011Ω min.", "100㏁ min"
  const irPatterns = [
    /(?:insulation\s*resistance|绝缘电阻)\s*[:：=]?\s*(?:[>＞]\s*)?(\d+\.?\d*)\s*(M|G|k|m)?\s*(?:Ω|\u2126|Ohm|ohm)/gi,
    /(?:insulation\s*resistance|绝缘电阻)\s*[:：=]?\s*(?:[>＞]\s*)?(\d+)\s*(?:㏁|㏀)/gi,
  ];
  // First pattern: explicit prefix
  while ((m = irPatterns[0].exec(text)) !== null) {
    const prefix = m[2];
    const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "k" ? 1e3 : prefix === "m" ? 1e-3 : 1;
    let val = parseFloat(m[1]) * mult;
    if (val < 1) val = parseFloat(m[1]) * 1e6; // mΩ misprint → MΩ
    // Detect concatenated exponent: "1011Ω" → 10^11 (value > 1e6 without prefix)
    if (!prefix) {
      const raw = m[1];
      if (raw.length >= 3 && raw.startsWith("10") && !raw.includes(".")) {
        const exp = parseInt(raw.substring(2));
        if (exp >= 6 && exp <= 15) { val = Math.pow(10, exp); }
      }
    }
    if (val > 0) { props.push({ key: "insulation_resistance", value: val, unit: "Ohm", source }); break; }
  }
  // Second pattern: ㏁ (Japanese megohm symbol) — "100㏁ min"
  if (!props.some((p) => p.key === "insulation_resistance")) {
    while ((m = irPatterns[1].exec(text)) !== null) {
      const val = parseInt(m[1]) * 1e6;
      if (val > 0) { props.push({ key: "insulation_resistance", value: val, unit: "Ohm", source }); break; }
    }
  }
  // scanSpecRow fallback for multiline insulation resistance
  if (!props.some((p) => p.key === "insulation_resistance")) {
    const irP = scanSpecRow(text, /(?:Insulation\s*Resistance|绝缘电阻)/i,
      (v) => v >= 100, "insulation_resistance", "Ohm", source);
    if (irP) {
      // Heuristic: if value matches 10+exp pattern (e.g., 1011 → 10^11), interpret as power of 10
      const raw = String(irP.value);
      if (raw.length >= 3 && raw.startsWith("10") && !raw.includes(".")) {
        const exp = parseInt(raw.substring(2));
        if (exp >= 6 && exp <= 15) irP.value = Math.pow(10, exp);
      }
      props.push(irP);
    }
  }
  // Standalone ㏁/㏀ search near "Insulation" or "绝缘" context
  if (!props.some((p) => p.key === "insulation_resistance")) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/insulation|绝缘/i.test(lines[i]) && !/insulation|绝缘/i.test(lines[Math.max(0, i-2)])) continue;
      for (let j = Math.max(0, i-1); j < Math.min(lines.length, i+3); j++) {
        const irm = lines[j].match(/(\d+)\s*(?:㏁|㏀)/);
        if (irm) {
          const val = parseInt(irm[1]) * 1e6;
          if (val > 0) { props.push({ key: "insulation_resistance", value: val, unit: "Ohm", source }); break; }
        }
      }
      if (props.some((p) => p.key === "insulation_resistance")) break;
    }
  }

  // Mechanical life / operating life — "1000 operations", "100,000 cycles", "1x10^7", "10,000 steps"
  const lifePatterns = [
    /(?:mechanical\s*life|operat(?:ing|ion)\s*life|endurance|durability|寿命)\s*[:：=]?\s*(?:[>＞]\s*)?(\d[\d,]*)\s*(?:operations?|cycles?|steps?|次|ops)/gi,
    /(?:mechanical\s*life|operat(?:ing|ion)\s*life|endurance|durability|寿命)\s*[:：=]?\s*(?:[>＞]\s*)?(\d+)\s*[x×]\s*10\^?\s*(\d+)/gi,
    /(\d[\d,]*)\s*(?:operations?|cycles?)\s*(?:Min|min)/gi,
    /(?:mechanical\s*life|operat(?:ing|ion)\s*life)\s*[:：=]?\s*(?:[>＞]\s*)?(\d[\d,]*)/gi,
    /step\s*of\s*operation\s*[:：=]?\s*(?:[>＞]\s*)?(\d[\d,]*)\s*(?:steps?)?/gi,
  ];
  // Pattern 1: plain number with unit suffix
  while ((m = lifePatterns[0].exec(text)) !== null) {
    const val = parseInt(m[1].replace(/,/g, ""));
    if (val >= 100 && val <= 1e10) { props.push({ key: "mechanical_life", value: val, unit: "cycles", source }); break; }
  }
  // Pattern 2: scientific notation
  if (!props.some((p) => p.key === "mechanical_life")) {
    while ((m = lifePatterns[1].exec(text)) !== null) {
      const val = parseInt(m[1]) * Math.pow(10, parseInt(m[2]));
      if (val >= 100 && val <= 1e10) { props.push({ key: "mechanical_life", value: val, unit: "cycles", source }); break; }
    }
  }
  // Pattern 4: plain number without unit suffix (e.g., "Operating Life  100,000")
  if (!props.some((p) => p.key === "mechanical_life")) {
    while ((m = lifePatterns[3].exec(text)) !== null) {
      const val = parseInt(m[1].replace(/,/g, ""));
      if (val >= 1000 && val <= 1e10) { props.push({ key: "mechanical_life", value: val, unit: "cycles", source }); break; }
    }
  }
  // Pattern 5: "Step of operation: 10,000 steps"
  if (!props.some((p) => p.key === "mechanical_life")) {
    while ((m = lifePatterns[4].exec(text)) !== null) {
      const val = parseInt(m[1].replace(/,/g, ""));
      if (val >= 100 && val <= 1e10) { props.push({ key: "mechanical_life", value: val, unit: "cycles", source }); break; }
    }
  }

  // Actuation / operation force — "800g Max.", "160±50gf", "250±50gf", "操作力"
  const forcePatterns = [
    /(?:operat(?:ing|ion)\s*force|actuation\s*force|操作力)\s*[:：=]?\s*(\d+\.?\d*)\s*(?:±\s*\d+\.?\d*)?\s*(?:g|gf|cN|mN)/gi,
    /(\d+)\s*(?:±\s*\d+)?\s*(?:gf?|cN)\s*(?:Max|max)/gi,
  ];
  for (const re of forcePatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 2000) { props.push({ key: "actuation_force", value: val, unit: "gf", source }); break; }
    }
    if (props.some((p) => p.key === "actuation_force")) break;
  }
  // Fallback: scanSpecRow for force
  if (!props.some((p) => p.key === "actuation_force")) {
    const forceP = scanSpecRow(text, /(?:operat(?:ing|ion)\s*force|actuation\s*force|pressing\s*force)/i,
      (v) => v > 0 && v <= 2000, "actuation_force", "gf", source);
    if (forceP) props.push(forceP);
  }

  // Travel distance — "0.25±0.15mm", "Travel: 1.5mm"
  const travelRe = /(?:travel|stroke|行程)\s*[:：=]?\s*(\d+\.?\d*)\s*(?:±\s*\d+\.?\d*)?\s*mm/gi;
  while ((m = travelRe.exec(text)) !== null) {
    const val = parseFloat(m[1]);
    if (val > 0 && val <= 10) { props.push({ key: "travel", value: val, unit: "mm", source }); break; }
  }

  // Dielectric strength / withstanding voltage — "300VAC Min.", "250V AC"
  const dielectricRe = /(?:dielectric\s*(?:strength|withstand)|withstand(?:ing)?\s*voltage|耐电压)\s*[:：=]?\s*(\d+)\s*V?\s*(?:AC|DC)?/gi;
  while ((m = dielectricRe.exec(text)) !== null) {
    const val = parseInt(m[1]);
    if (val > 0 && val <= 10000) { props.push({ key: "dielectric_strength", value: val, unit: "V", source }); break; }
  }

  return props;
}

function extractSwitchKeywords(text: string): string[] {
  const kw: string[] = [];

  // Contact form
  if (/\bSPST\b/i.test(text)) kw.push("SPST");
  if (/\bSPDT\b/i.test(text)) kw.push("SPDT");
  if (/\bDPST\b/i.test(text)) kw.push("DPST");
  if (/\bDPDT\b/i.test(text)) kw.push("DPDT");

  // Switch type keywords
  if (/\btactile\b/i.test(text)) kw.push("tactile");
  if (/\bslide\b/i.test(text)) kw.push("slide");
  if (/\btoggle\b/i.test(text)) kw.push("toggle");
  if (/\brotary\b/i.test(text)) kw.push("rotary");
  if (/\bDIP\b/.test(text)) kw.push("DIP");
  if (/\brocker\b/i.test(text)) kw.push("rocker");
  if (/\bpush[\s-]?button\b/i.test(text)) kw.push("push-button");
  if (/\bmicro[\s-]?switch\b/i.test(text)) kw.push("micro-switch");
  if (/\bdetect\b/i.test(text)) kw.push("detect");
  if (/\bmomentary\b/i.test(text)) kw.push("momentary");
  if (/\blatching\b/i.test(text)) kw.push("latching");

  // Illumination
  if (/\bLED\b|\blight\b|\billuminat/i.test(text)) kw.push("illuminated");

  // Sealing / protection
  if (/\bsealed\b/i.test(text)) kw.push("sealed");
  if (/\bwaterproof\b/i.test(text)) kw.push("waterproof");
  const ipM = text.match(/\b(IP\d{2})\b/i);
  if (ipM) kw.push(ipM[1].toUpperCase());

  // Mounting
  if (/\bSMT\b|surface\s*mount/i.test(text)) kw.push("SMT");
  if (/\bthrough[\s-]?hole\b|THT\b/i.test(text)) kw.push("through-hole");

  // Material
  if (/\bgold[\s-]*plat/i.test(text)) kw.push("gold-plated");
  if (/\bsilver[\s-]*plat/i.test(text)) kw.push("silver-plated");

  return [...new Set(kw)];
}

// ── Relay extractors ──

function extractRelayProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // Coil voltage — "Rated voltage 5VDC", "额定电压 12VDC", "coil voltage: 5V"
  // Note: 额定电压 must NOT be followed by 下 (which means "at rated voltage")
  const coilVoltagePatterns = [
    /(?:rated\s*voltage|coil\s*voltage|nominal\s*voltage)\s*[:：=]?\s*(\d+\.?\d*)\s*V\s*(?:DC|AC)?/gi,
    /额定电压\s*(?!下)[:：=]?\s*(\d+\.?\d*)\s*V\s*(?:DC|AC)?/gi,
    /(\d+)\s*V\s*DC\s*(?:coil|relay)/gi,
  ];
  for (const re of coilVoltagePatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 250) { props.push({ key: "coil_voltage", value: val, unit: "V", source }); break; }
    }
    if (props.some((p) => p.key === "coil_voltage")) break;
  }
  // Fallback: scan for "Coil voltage : 03,05,06,09,12,24 (VDC)" ordering info
  if (!props.some((p) => p.key === "coil_voltage")) {
    const cvOrderRe = /Coil\s*voltage\s*[:：]\s*([\d,]+)\s*\(?\s*V\s*(?:DC|AC)?\s*\)?/i;
    const cvM = text.match(cvOrderRe);
    if (cvM) {
      const first = parseInt(cvM[1].split(",")[0]);
      if (first > 0 && first <= 250) props.push({ key: "coil_voltage", value: first, unit: "V", source });
    }
  }
  // Fallback: scan coil data table — skip "额定电压下" (at rated voltage) and "of rated voltage"
  if (!props.some((p) => p.key === "coil_voltage")) {
    const coilP = scanSpecRow(text, /(?:Rated\s*voltage|Coil\s*Voltage)\s*(?!.*of\s*rated)/i,
      (v) => v > 0 && v <= 250, "coil_voltage", "V", source,
      /额定电压下|of\s*rated\s*voltage|at\s*nomi/i);
    if (coilP) props.push(coilP);
  }

  // Coil resistance — "125Ω", "Coil Resistance: 720Ω", "线圈电阻"
  const coilResPatterns = [
    /(?:coil\s*resistance|线圈电阻)\s*[:：=]?\s*(?:±\s*\d+%\s*)?(\d[\d,]*\.?\d*)\s*(?:Ω|\u2126|Ohm|ohm)/gi,
  ];
  for (const re of coilResPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (val > 0 && val <= 100000) { props.push({ key: "coil_resistance", value: val, unit: "Ohm", source }); break; }
    }
    if (props.some((p) => p.key === "coil_resistance")) break;
  }
  // Fallback: find "Coil resistance" header, skip unit rows, read first data row
  if (!props.some((p) => p.key === "coil_resistance")) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/Coil\s*resistance|线圈电阻/i.test(lines[i])) continue;
      // Skip header and unit rows, find first data row with numbers
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (/\(Ω|±10%|\(VDC\)|\(mA\)/i.test(lines[j])) continue; // skip unit rows
        if (/Rated|voltage|current|resistance/i.test(lines[j])) continue; // skip repeated headers
        const nums = [...lines[j].matchAll(/(\d+\.?\d*)/g)].map(n => parseFloat(n[1]));
        // Coil resistance is typically the 3rd column (after voltage, current)
        if (nums.length >= 3) {
          const val = nums[2];
          if (val > 0 && val <= 100000) { props.push({ key: "coil_resistance", value: val, unit: "Ohm", source }); break; }
        }
      }
      if (props.some((p) => p.key === "coil_resistance")) break;
    }
  }

  // Coil power — "Rated coil power: 0.2W", "200mW", "线圈功率"
  const coilPowerPatterns = [
    /(?:coil\s*power|rated\s*(?:coil\s*)?power|线圈功率|额定功率)\s*[:：=]?\s*(?:约\s*)?(?:approx\.?\s*)?(\d+\.?\d*)\s*(m?)\s*W/gi,
    /(\d+)\s*mW\s*coil\s*power/gi,
  ];
  for (const re of coilPowerPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
      if (val > 0 && val <= 10) { props.push({ key: "coil_power", value: val, unit: "W", source }); break; }
    }
    if (props.some((p) => p.key === "coil_power")) break;
  }

  // Contact rating current — "3A 250VAC", "Contact Rating: 5A", "额定负载"
  const contactCurrentPatterns = [
    /(?:contact\s*rating|rated\s*(?:load|current)|额定负载)\s*(?:\(.*?\))?\s*[:：=]?\s*(\d+\.?\d*)\s*A/gi,
    /(?:max(?:imum)?\s*switching\s*current|最大切换电流)\s*[:：=]?\s*(\d+\.?\d*)\s*A/gi,
  ];
  for (const re of contactCurrentPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 100) { props.push({ key: "contact_rating_current", value: val, unit: "A", source }); break; }
    }
    if (props.some((p) => p.key === "contact_rating_current")) break;
  }

  // Contact rating voltage — extract from "3A 250VAC/30VDC"
  const contactVoltagePatterns = [
    /(?:contact\s*rating|rated\s*(?:load|voltage)|额定负载)\s*(?:\(.*?\))?\s*[:：=]?\s*\d+\.?\d*\s*A\s*(\d+)\s*V\s*(?:AC|DC)/gi,
    /(?:max(?:imum)?\s*switching\s*voltage|最大切换电压)\s*[:：=]?\s*(\d+)\s*V\s*(?:AC|DC)?/gi,
  ];
  for (const re of contactVoltagePatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseInt(m[1]);
      if (val > 0 && val <= 600) { props.push({ key: "contact_rating_voltage", value: val, unit: "V", source }); break; }
    }
    if (props.some((p) => p.key === "contact_rating_voltage")) break;
  }

  // Max switching power — "750VA", "84W", "最大切换功率"
  const switchPowerPatterns = [
    /(?:max(?:imum)?\s*switching\s*power|最大切换功率)\s*[:：=]?\s*(\d+)\s*(?:VA|W)/gi,
  ];
  for (const re of switchPowerPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseInt(m[1]);
      if (val > 0 && val <= 10000) { props.push({ key: "max_switching_power", value: val, unit: "W", source }); break; }
    }
    if (props.some((p) => p.key === "max_switching_power")) break;
  }

  // Contact resistance — "100mΩ Max."
  const crPatterns = [
    /(?:contact\s*resistance|接触电阻)\s*[:：=<≤]?\s*(\d+\.?\d*)\s*(m?)\s*(?:Ω|\u2126|Ohm|ohm)/gi,
  ];
  for (const re of crPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
      if (val > 0 && val < 10) { props.push({ key: "contact_resistance", value: val, unit: "Ohm", source }); break; }
    }
    if (props.some((p) => p.key === "contact_resistance")) break;
  }

  // Insulation resistance — "100MΩ Min."
  const irPatterns = [
    /(?:insulation\s*resistance|绝缘电阻)\s*[:：=]?\s*(?:[>＞]\s*)?(\d+\.?\d*)\s*(M|G|k)?\s*(?:Ω|\u2126|Ohm|ohm)/gi,
  ];
  for (const re of irPatterns) {
    while ((m = re.exec(text)) !== null) {
      const prefix = m[2];
      const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "k" ? 1e3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0) { props.push({ key: "insulation_resistance", value: val, unit: "Ohm", source }); break; }
    }
    if (props.some((p) => p.key === "insulation_resistance")) break;
  }

  // Operate time — "10ms Max.", "Operate Time: 15ms"
  const operateTimePatterns = [
    /(?:operat(?:e|ing)\s*time|吸合时间)\s*(?:\(.*?\))?\s*[:：=]?\s*(\d+\.?\d*)\s*ms/gi,
  ];
  for (const re of operateTimePatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 100) { props.push({ key: "operate_time", value: val, unit: "ms", source }); break; }
    }
    if (props.some((p) => p.key === "operate_time")) break;
  }

  // Release time — "4ms Max.", "Release Time: 5ms"
  const releaseTimePatterns = [
    /(?:release\s*time|释放时间)\s*(?:\(.*?\))?\s*[:：=]?\s*(\d+\.?\d*)\s*ms/gi,
  ];
  for (const re of releaseTimePatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 100) { props.push({ key: "release_time", value: val, unit: "ms", source }); break; }
    }
    if (props.some((p) => p.key === "release_time")) break;
  }

  // Mechanical endurance — "1x10^7 OPS", "2x10^7 cycles", "机械寿命"
  const mechLifePatterns = [
    /(?:mechanical\s*endurance|mechanical\s*life|机械寿命)\s*[:：=]?\s*(?:[>＞]\s*)?(\d+)\s*[x×]\s*10\^?\s*(\d+)/gi,
    /(?:mechanical\s*endurance|mechanical\s*life|机械寿命)\s*[:：=]?\s*(?:[>＞]\s*)?(\d[\d,]*)\s*(?:operations?|cycles?|次|ops)/gi,
  ];
  while ((m = mechLifePatterns[0].exec(text)) !== null) {
    const val = parseInt(m[1]) * Math.pow(10, parseInt(m[2]));
    if (val >= 100) { props.push({ key: "mechanical_life", value: val, unit: "cycles", source }); break; }
  }
  if (!props.some((p) => p.key === "mechanical_life")) {
    while ((m = mechLifePatterns[1].exec(text)) !== null) {
      const val = parseInt(m[1].replace(/,/g, ""));
      if (val >= 100) { props.push({ key: "mechanical_life", value: val, unit: "cycles", source }); break; }
    }
  }

  // Electrical endurance — "1x10^5 OPS", "电气寿命"
  const elecLifePatterns = [
    /(?:electric(?:al)?\s*endurance|electric(?:al)?\s*life|电气寿命)\s*[:：=]?\s*(?:[>＞]\s*)?(\d+)\s*[x×]\s*10\^?\s*(\d+)/gi,
    /(?:electric(?:al)?\s*endurance|electric(?:al)?\s*life|电气寿命)\s*[:：=]?\s*(?:[>＞]\s*)?(\d[\d,]*)\s*(?:operations?|cycles?|次|ops)/gi,
  ];
  while ((m = elecLifePatterns[0].exec(text)) !== null) {
    const val = parseInt(m[1]) * Math.pow(10, parseInt(m[2]));
    if (val >= 100) { props.push({ key: "electrical_life", value: val, unit: "cycles", source }); break; }
  }
  if (!props.some((p) => p.key === "electrical_life")) {
    while ((m = elecLifePatterns[1].exec(text)) !== null) {
      const val = parseInt(m[1].replace(/,/g, ""));
      if (val >= 100) { props.push({ key: "electrical_life", value: val, unit: "cycles", source }); break; }
    }
  }

  // Dielectric strength — "500VAC, 50/60Hz 1 min", "Dielectric Strength: 750VAC"
  const dielectricRe = /(?:dielectric\s*(?:strength|withstand)|介质耐压)\s*[:：=]?\s*(?:.*?)\s*(\d+)\s*V\s*(?:AC|DC)/gi;
  while ((m = dielectricRe.exec(text)) !== null) {
    const val = parseInt(m[1]);
    if (val > 0 && val <= 10000) { props.push({ key: "dielectric_strength", value: val, unit: "V", source }); break; }
  }

  // Table-based extraction for relay spec tables
  const tableProps = scanTable(text, [
    { pattern: /\bRated\s*voltage|额定电压/i, key: "coil_voltage", unit: "V" },
    { pattern: /\bCoil\s*Resistance|线圈电阻/i, key: "coil_resistance", unit: "Ohm" },
    { pattern: /\bOperate\s*(?:Time|voltage)|吸合/i, key: "operate_time", unit: "ms" },
  ], source);
  const existing = new Set(props.map((p) => p.key));
  for (const tp of tableProps) { if (!existing.has(tp.key)) props.push(tp); }

  return props;
}

function extractRelayKeywords(text: string): string[] {
  const kw: string[] = [];

  // Contact form/arrangement — 1A (SPST-NO), 1B (SPST-NC), 1C (SPDT), 2C (DPDT), etc.
  if (/\bSPST[\s-]*NO\b|contact.*\b1A\b/i.test(text)) kw.push("SPST-NO");
  if (/\bSPST[\s-]*NC\b|contact.*\b1B\b/i.test(text)) kw.push("SPST-NC");
  if (/\bSPDT\b|\b1C\b.*contact|contact.*\b1C\b/i.test(text)) kw.push("SPDT");
  if (/\bDPST\b|\b2A\b.*contact|contact.*\b2A\b/i.test(text)) kw.push("DPST");
  if (/\bDPDT\b|\b2C\b.*contact|contact.*\b2C\b/i.test(text)) kw.push("DPDT");
  // Generic Form C/A/B
  if (/\bForm\s*C\b/i.test(text)) kw.push("SPDT");
  if (/\bForm\s*A\b/i.test(text)) kw.push("SPST-NO");
  if (/\bForm\s*B\b/i.test(text)) kw.push("SPST-NC");

  // Relay type keywords
  if (/\bsignal\s*relay\b/i.test(text)) kw.push("signal-relay");
  if (/\bpower\s*relay\b/i.test(text)) kw.push("power-relay");
  if (/\blatching\b/i.test(text)) kw.push("latching");
  if (/\bpolarized\b/i.test(text)) kw.push("polarized");
  if (/\bnon[\s-]*polarized\b/i.test(text)) kw.push("non-polarized");
  if (/\bsolid[\s-]*state\b/i.test(text)) kw.push("solid-state");
  if (/\breed\s*relay\b/i.test(text)) kw.push("reed-relay");

  // Coil type
  if (/\bDC\s*coil\b|\bVDC\b/i.test(text)) kw.push("DC-coil");
  if (/\bAC\s*coil\b|\bVAC\b.*coil/i.test(text)) kw.push("AC-coil");

  // Sealing/construction
  if (/\bsealed\b/i.test(text)) kw.push("sealed");
  if (/\bflux[\s-]*proof\b|塑封/i.test(text)) kw.push("flux-proof");
  if (/\bdust[\s-]*(?:cover|protect)\b/i.test(text)) kw.push("dust-protected");
  if (/\bwash[\s-]*tight\b/i.test(text)) kw.push("wash-tight");

  // Mounting
  if (/\bSMT\b|\bSMD\b|surface\s*mount/i.test(text)) kw.push("SMT");
  if (/\bthrough[\s-]?hole\b|\bTHT\b|\bPCB\s*mount/i.test(text)) kw.push("through-hole");
  if (/\bplug[\s-]?in\b/i.test(text)) kw.push("plug-in");
  if (/\bsocket\b/i.test(text)) kw.push("socket");

  // Contact material
  if (/\bAgSnO2\b/i.test(text)) kw.push("AgSnO2");
  if (/\bAgNi\b/i.test(text)) kw.push("AgNi");
  if (/\bAgCdO\b/i.test(text)) kw.push("AgCdO");
  if (/\bsilver\s*alloy\b|银合金/i.test(text)) kw.push("silver-alloy");

  return [...new Set(kw)];
}

// ── Memory extractors ──

function extractMemoryProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // ── Capacity — Kbit/Mbit/Gbit (canonical unit: bit) ──
  // Match "128M-bit", "128Mbit", "128 Mbit", "64Gbit", "32Kbit", "4 Kbit", "32K SPI Bus"
  // Also match from descriptions: "8Kbit", "512Mbit", "2Gbit"
  const capPatterns = [
    /(\d+\.?\d*)\s*([KkMmGg])\s*-?\s*[Bb]it(?:s)?\b/g,
    /\b(\d+\.?\d*)\s*([KkMmGg])\s*[Bb]it(?:s)?\b/g,
    /\b(\d+)\s*([KkMmGg])\s*(?:bytes?|B)\b/g,    // "16M-Byte" -> convert to bits
  ];
  let capBits = 0;
  for (const capRe of capPatterns) {
    if (capBits > 0) break;
    while ((m = capRe.exec(text)) !== null) {
      const num = parseFloat(m[1]);
      const prefix = m[2].toUpperCase();
      const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
      // If pattern matches bytes, convert to bits
      const isByte = /bytes?|B\b/.test(m[0]);
      const bits = num * mult * (isByte ? 8 : 1);
      if (bits > 0 && bits <= 1e12) { capBits = bits; break; }
    }
  }
  if (capBits > 0) {
    // Store in the most natural unit
    if (capBits >= 1e9) props.push({ key: "capacity", value: capBits / 1e9, unit: "Gbit", source });
    else if (capBits >= 1e6) props.push({ key: "capacity", value: capBits / 1e6, unit: "Mbit", source });
    else props.push({ key: "capacity", value: capBits / 1e3, unit: "Kbit", source });
  }

  // ── Organization — "256K x 8", "16Kx8", "4096x8", "512 x 8-Bit" ──
  const orgRe = /(\d+\.?\d*)\s*([KkMmGg])?\s*[×xX]\s*(\d+)\s*(?:-?\s*[Bb]it)?/g;
  while ((m = orgRe.exec(text)) !== null) {
    const words = parseInt(m[1]);
    const prefix = (m[2] ?? "").toUpperCase();
    const wordMult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
    const width = parseInt(m[3]);
    const totalWords = words * wordMult;
    if (totalWords >= 64 && width >= 1 && width <= 64) {
      props.push({ key: "org_width", value: width, unit: "bit", source });
      break;
    }
  }

  // ── Clock / Speed — MHz for SPI/parallel, also "Max. Clock 10 MHz" ──
  const clockPatterns = [
    /(?:max(?:imum)?\s*(?:clock|SPI|SCK)\s*(?:freq(?:uency)?)?|clock\s*(?:freq(?:uency)?)|(?:SPI|SCK|SCL)\s*(?:clock\s*)?(?:freq(?:uency)?)?)\s*[:=]?\s*(\d+\.?\d*)\s*(k|M|G)?\s*Hz/gi,
    /\b(\d+)\s*(M)Hz\s*(?:SPI|clock|for\s*fast\s*read)/gi,
    /(?:clock\s*freq(?:uency)?|fSCK|fSCL|fCLK)\s*[:=]?\s*(?:up\s*to\s*)?(\d+\.?\d*)\s*(k|M|G)?\s*Hz/gi,
  ];
  for (const clkRe of clockPatterns) {
    if (props.some((p) => p.key === "clock_mhz")) break;
    while ((m = clkRe.exec(text)) !== null) {
      const num = parseFloat(m[1]);
      const prefix = (m[2] ?? "").toUpperCase();
      const mult = prefix === "G" ? 1e3 : prefix === "M" ? 1 : prefix === "K" ? 0.001 : 1e-6;
      const mhz = num * mult;
      if (mhz > 0 && mhz <= 10000) { props.push({ key: "clock_mhz", value: mhz, unit: "MHz", source }); break; }
    }
  }
  // Fallback: "NNN MHz" near "clock" or "speed" in description text
  if (!props.some((p) => p.key === "clock_mhz") && source !== "datasheet") {
    const descClk = text.match(/(\d+\.?\d*)\s*(k|M|G)?Hz/i);
    if (descClk) {
      const num = parseFloat(descClk[1]);
      const prefix = (descClk[2] ?? "").toUpperCase();
      const mult = prefix === "G" ? 1e3 : prefix === "M" ? 1 : prefix === "K" ? 0.001 : 1e-6;
      const mhz = num * mult;
      if (mhz > 0 && mhz <= 10000) props.push({ key: "clock_mhz", value: mhz, unit: "MHz", source });
    }
  }

  // ── Write endurance — "1,000,000 Program/Erase Cycles", "100,000 cycles" ──
  const endurPatterns = [
    /(?:endurance|erase\s*\/?\s*write\s*cycles?|program\s*\/?\s*erase\s*cycles?|write\s*(?:cycle|endurance))\s*[:=]?\s*(?:min(?:imum)?\s*)?(\d[\d,]*)\s*(?:cycles?|times?)?/gi,
    /(\d[\d,]*)\s*(?:Program\s*\/?\s*Erase\s*Cycles?|Erase\s*\/?\s*Write\s*[Cc]ycles?|[Ee]rase\s*[Cc]ycles?|[Ww]rite\s*[Cc]ycles?)/g,
  ];
  for (const endRe of endurPatterns) {
    if (props.some((p) => p.key === "endurance_cycles")) break;
    while ((m = endRe.exec(text)) !== null) {
      const str = m[1].replace(/,/g, "");
      const v = parseInt(str);
      if (v >= 100 && v <= 1e8) { props.push({ key: "endurance_cycles", value: v, unit: "cycles", source }); break; }
    }
  }

  // ── Data retention — "200 years", "20-year data retention" ──
  const retPatterns = [
    /(?:data\s*retention|retention)\s*[:=]?\s*(?:[>＞]\s*)?(\d+)\s*[Yy]ears?/gi,
    /(\d+)\s*[Yy]ears?\s*(?:data\s*)?retention/gi,
  ];
  for (const retRe of retPatterns) {
    if (props.some((p) => p.key === "retention_years")) break;
    while ((m = retRe.exec(text)) !== null) {
      const v = parseInt(m[1]);
      if (v >= 1 && v <= 1000) { props.push({ key: "retention_years", value: v, unit: "years", source }); break; }
    }
  }

  // ── Access time / read time — for SRAM, DRAM: "55ns", "10ns access time" ──
  const accessRe = /(?:access\s*time|tAA|tRC|read\s*cycle\s*time)\s*[:=]?\s*(\d+\.?\d*)\s*(n|u|μ|µ)?\s*s/gi;
  while ((m = accessRe.exec(text)) !== null) {
    const prefix = (m[2] ?? "").toLowerCase();
    const mult = prefix === "n" ? 1 : (prefix === "u" || prefix === "μ" || prefix === "µ") ? 1000 : 1e9;
    const ns = parseFloat(m[1]) * mult;
    if (ns > 0 && ns < 1e6) { props.push({ key: "access_time_ns", value: ns, unit: "ns", source }); break; }
  }
  // Fallback: "NNns" in descriptions (e.g., "55ns")
  if (!props.some((p) => p.key === "access_time_ns") && source !== "datasheet") {
    const nsDesc = text.match(/\b(\d+)\s*ns\b/);
    if (nsDesc) {
      const v = parseInt(nsDesc[1]);
      if (v >= 1 && v <= 10000) props.push({ key: "access_time_ns", value: v, unit: "ns", source });
    }
  }

  // ── Write cycle time — "5 ms Maximum" ──
  const wctRe = /(?:write\s*cycle\s*(?:time)?|(?:self[\s-]*timed\s*)?program(?:ming)?\s*(?:cycle\s*)?(?:time)?)\s*[:=]?\s*(\d+\.?\d*)\s*(m|u|μ|µ)?\s*s/gi;
  while ((m = wctRe.exec(text)) !== null) {
    const prefix = (m[2] ?? "").toLowerCase();
    const mult = prefix === "m" ? 1 : (prefix === "u" || prefix === "μ" || prefix === "µ") ? 0.001 : 1000;
    const ms = parseFloat(m[1]) * mult;
    if (ms > 0 && ms <= 1000) { props.push({ key: "write_cycle_ms", value: ms, unit: "ms", source }); break; }
  }

  return props;
}

function extractMemoryKeywords(text: string): string[] {
  const kw: string[] = [];

  // Interface type
  if (/\bSPI\b/i.test(text)) kw.push("spi");
  if (/\bI2C\b|\bI\u00B2C\b/i.test(text)) kw.push("i2c");
  if (/\bparallel\b/i.test(text)) kw.push("parallel");
  if (/\bQSPI\b|\bQuad\s*SPI\b/i.test(text)) kw.push("qspi");
  if (/\bDual\s*SPI\b/i.test(text)) kw.push("dual-spi");
  if (/\bSD[\s-]?(?:bus|mode|interface|2\.0)\b/i.test(text)) kw.push("sd");
  if (/\beMMC\b/i.test(text)) kw.push("emmc");
  if (/\bDDR\d?\b/i.test(text)) { const dm = text.match(/\b(DDR\d?L?)\b/i); if (dm) kw.push(dm[1].toLowerCase()); }
  if (/\bLPDDR\d?\b/i.test(text)) { const lm = text.match(/\b(LPDDR\d?)\b/i); if (lm) kw.push(lm[1].toLowerCase()); }

  // Memory type keywords (from text body, not just subcategory)
  if (/\bEEPROM\b/i.test(text)) kw.push("eeprom");
  if (/\bFLASH\b/i.test(text)) kw.push("flash");
  if (/\bNOR\s*FLASH\b/i.test(text)) kw.push("nor-flash");
  if (/\bNAND\s*FLASH\b/i.test(text)) kw.push("nand-flash");
  if (/\bSRAM\b/i.test(text)) kw.push("sram");
  if (/\bDRAM\b/i.test(text)) kw.push("dram");
  if (/\bFRAM\b|\bFeRAM\b/i.test(text)) kw.push("fram");
  if (/\bnvSRAM\b/i.test(text)) kw.push("nvsram");
  if (/\bPSRAM\b/i.test(text)) kw.push("psram");

  // Flash type
  if (/\bMLC\b/.test(text)) kw.push("mlc");
  if (/\bSLC\b/.test(text)) kw.push("slc");
  if (/\bTLC\b/.test(text)) kw.push("tlc");
  if (/\bQLC\b/.test(text)) kw.push("qlc");

  // Feature keywords
  if (/\bECC\b|Error\s*Correction/i.test(text)) kw.push("ecc");
  if (/\bOTP\b|One[\s-]*Time[\s-]*Program/i.test(text)) kw.push("otp");
  if (/\bwrite[\s-]*protect/i.test(text)) kw.push("write-protect");
  if (/\bXiP\b|eXecute\s*in\s*Place/i.test(text)) kw.push("xip");
  if (/\bwear[\s-]*leveling/i.test(text)) kw.push("wear-leveling");
  if (/\bdeep\s*power[\s-]*down\b/i.test(text)) kw.push("deep-power-down");
  if (/\bpage\s*(?:write|program)\b/i.test(text)) kw.push("page-write");

  return [...new Set(kw)];
}

// ── Logic extractors ──

function extractLogicProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // ── Propagation delay — tpd, tPLH, tPHL ──
  // Inline patterns: "tpd = 3.6 ns", "1.4 ns Typical Propagation Delay"
  const tpdPatterns = [
    /\bt[Pp][Dd]\s*[:=]?\s*(\d+\.?\d*)\s*(n|p|u|μ|µ)?\s*s/g,
    /(\d+\.?\d*)\s*(n|p)s\s*(?:Typical\s*)?(?:Max(?:imum)?\s*)?Propagation\s*Delay/gi,
    /Propagation\s*[Dd]elay\s*(?:Time)?\s*[:=]?\s*(\d+\.?\d*)\s*(n|p|u|μ|µ)?\s*s/gi,
  ];
  for (const tpdRe of tpdPatterns) {
    if (props.some((p) => p.key === "tpd_ns")) break;
    while ((m = tpdRe.exec(text)) !== null) {
      const prefix = (m[2] ?? "n").toLowerCase();
      const mult = prefix === "p" ? 0.001 : prefix === "n" ? 1 : (prefix === "u" || prefix === "μ" || prefix === "µ") ? 1000 : 1;
      const ns = parseFloat(m[1]) * mult;
      if (ns > 0 && ns < 1e6) { props.push({ key: "tpd_ns", value: ns, unit: "ns", source }); break; }
    }
  }
  // Spec-row fallback: "tPLH / tPHL" rows in switching characteristics tables
  if (!props.some((p) => p.key === "tpd_ns")) {
    const tplhP = scanSpecRow(text, /\bt[Pp][Ll][Hh]\b/, (v) => v > 0 && v < 10000, "tpd_ns", "ns", source);
    if (tplhP) props.push(tplhP);
  }
  if (!props.some((p) => p.key === "tpd_ns")) {
    const tphlP = scanSpecRow(text, /\bt[Pp][Hh][Ll]\b/, (v) => v > 0 && v < 10000, "tpd_ns", "ns", source);
    if (tphlP) props.push(tphlP);
  }
  // Description-level fallback: "7.5ns@5V,50pF", "14ns@5V,15pF"
  if (!props.some((p) => p.key === "tpd_ns") && source !== "datasheet") {
    const descTpd = text.match(/(\d+\.?\d*)\s*ns\s*@/);
    if (descTpd) {
      const v = parseFloat(descTpd[1]);
      if (v > 0 && v < 10000) props.push({ key: "tpd_ns", value: v, unit: "ns", source });
    }
  }

  // ── Output drive current — IOH, IOL ──
  // IOH (source current, usually negative, take absolute value)
  const iohP = scanSpecRow(text, /\bI[Oo][Hh]\b|\bHigh[\s-]*level\s*output\s*current/i,
    (v) => v > 0 && v <= 200, "ioh_ma", "mA", source);
  if (iohP) props.push(iohP);
  // IOL (sink current)
  const iolP = scanSpecRow(text, /\bI[Oo][Ll]\b|\bLow[\s-]*level\s*output\s*current/i,
    (v) => v > 0 && v <= 200, "iol_ma", "mA", source);
  if (iolP) props.push(iolP);

  // Inline: "IOH = -1 mA" or "IOL = 20 mA" or "24 mA TTL outputs"
  if (!props.some((p) => p.key === "iol_ma")) {
    const iolInline = /I[Oo][Ll]\s*[:=]?\s*-?\s*(\d+\.?\d*)\s*m?\s*A/g;
    while ((m = iolInline.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0 && v <= 200) { props.push({ key: "iol_ma", value: v, unit: "mA", source }); break; }
    }
  }
  if (!props.some((p) => p.key === "ioh_ma")) {
    const iohInline = /I[Oo][Hh]\s*[:=]?\s*-?\s*(\d+\.?\d*)\s*m?\s*A/g;
    while ((m = iohInline.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0 && v <= 200) { props.push({ key: "ioh_ma", value: v, unit: "mA", source }); break; }
    }
  }

  // ── Maximum frequency — for counters, dividers, FIFOs ──
  const fmaxRe = /(?:max(?:imum)?\s*(?:clock\s*)?freq(?:uency)?|fmax|f\s*max)\s*[:=]?\s*(\d+\.?\d*)\s*(k|M|G)?\s*Hz/gi;
  while ((m = fmaxRe.exec(text)) !== null) {
    const num = parseFloat(m[1]);
    const prefix = (m[2] ?? "").toUpperCase();
    const mult = prefix === "G" ? 1e3 : prefix === "M" ? 1 : prefix === "K" ? 0.001 : 1e-6;
    const mhz = num * mult;
    if (mhz > 0 && mhz <= 50000) { props.push({ key: "fmax_mhz", value: mhz, unit: "MHz", source }); break; }
  }

  // ── Number of gates/channels/bits — from title/description ──
  // "QUADRUPLE 2-INPUT" -> 4, "SINGLE" -> 1, "DUAL" -> 2, "TRIPLE" -> 3, "HEX" -> 6, "OCTAL" -> 8
  // Search near gate/input context to avoid "Also Available as Dual" false positives
  const front = text.substring(0, Math.min(text.length, 2000));
  const countWords: [RegExp, number][] = [
    [/\bSINGLE\b/i, 1], [/\bDUAL\b/i, 2], [/\bTRIPLE\b/i, 3],
    [/\bQUADRUPLE\b|\bQUAD\b/i, 4], [/\bQUINTUPLE\b/i, 5],
    [/\bHEX\b/i, 6], [/\bOCTAL\b/i, 8],
  ];
  // First pass: find earliest count word near gate/input context (within 40 chars)
  let bestGatePos = Infinity, bestGateCount = 0;
  for (const [re, count] of countWords) {
    const cm = front.match(re);
    if (cm && cm.index !== undefined && cm.index < bestGatePos) {
      const after = front.substring(cm.index, cm.index + 40);
      if (/\d[\s-]*input|gate|buffer|driver|invert|channel|flip|latch|line/i.test(after)) {
        bestGatePos = cm.index;
        bestGateCount = count;
      }
    }
  }
  if (bestGateCount > 0) {
    props.push({ key: "gate_count", value: bestGateCount, unit: "gates", source });
  }
  // Fallback: first count word in title area
  if (!props.some((p) => p.key === "gate_count")) {
    for (const [re, count] of countWords) {
      if (re.test(front)) {
        props.push({ key: "gate_count", value: count, unit: "gates", source });
        break;
      }
    }
  }
  // Numeric from description: "1 " or "2 " or "8 " preceding a gate type or as standalone channel count
  if (!props.some((p) => p.key === "gate_count") && source !== "datasheet") {
    const gcDesc = text.match(/\b(\d{1,2})\s+(?:gates?|channels?|buffers?|drivers?|receivers?|inverters?)\b/i);
    if (gcDesc) {
      const v = parseInt(gcDesc[1]);
      if (v >= 1 && v <= 16) props.push({ key: "gate_count", value: v, unit: "gates", source });
    }
  }

  return props;
}

function extractLogicKeywords(text: string): string[] {
  const kw: string[] = [];

  // Logic family — from 74-series naming and explicit mentions
  const families: [RegExp, string][] = [
    [/\b74AUP\b/i, "aup"], [/\b74AUC\b/i, "auc"],
    [/\b74AVC\b/i, "avc"], [/\b74ALVC\b/i, "alvc"],
    [/\b74LVC\b/i, "lvc"], [/\b74AHCT\b/i, "ahct"],
    [/\b74AHC\b/i, "ahc"], [/\b74HCT\b/i, "hct"],
    [/\b74HC\b/i, "hc"], [/\b74VHC\b/i, "vhc"],
    [/\b74FCT\b/i, "fct"], [/\b74ABT\b/i, "abt"],
    [/\b74ACT\b/i, "act"], [/\b74AC\b/i, "ac"],
    [/\b74LS\b/i, "ls"], [/\b74F\b/i, "f"],
    [/\b74S\b/i, "s"], [/\b74LV\b/i, "lv"],
    [/\b74AS\b/i, "as"], [/\b74ALS\b/i, "als"],
    [/\bCD4\d{3}\b/i, "cd4000"],
  ];
  for (const [re, name] of families) {
    if (re.test(text)) { kw.push(name); break; }
  }

  // Technology
  if (/\bCMOS\b/i.test(text)) kw.push("cmos");
  if (/\bTTL\b/i.test(text)) kw.push("ttl");
  if (/\bLVTTL\b/i.test(text)) kw.push("lvttl");
  if (/\bLVCMOS\b/i.test(text)) kw.push("lvcmos");
  if (/\bLVPECL\b/i.test(text)) kw.push("lvpecl");
  if (/\bLVDS\b/i.test(text)) kw.push("lvds");
  if (/\bCML\b/i.test(text)) kw.push("cml");
  if (/\bECL\b|\bPECL\b/i.test(text)) kw.push("ecl");
  if (/\bBiCMOS\b/i.test(text)) kw.push("bicmos");

  // Gate type keywords
  if (/\bNAND\s*[Gg]ate/i.test(text)) kw.push("nand");
  if (/\bNOR\s*[Gg]ate/i.test(text)) kw.push("nor");
  if (/\bAND\s*[Gg]ate/i.test(text)) kw.push("and");
  if (/\bOR\s*[Gg]ate/i.test(text)) kw.push("or");
  if (/\b(?:exclusive[\s-]*OR|XOR|EXOR)\b/i.test(text)) kw.push("xor");
  if (/\bXNOR\b|\bexclusive[\s-]*NOR\b/i.test(text)) kw.push("xnor");
  if (/\b[Ii]nverter/i.test(text)) kw.push("inverter");
  if (/\b[Bb]uffer/i.test(text)) kw.push("buffer");

  // Functional keywords
  if (/\bSchmitt\s*[Tt]rigger/i.test(text)) kw.push("schmitt-trigger");
  if (/\b[Oo]pen[\s-]*[Dd]rain\b/i.test(text)) kw.push("open-drain");
  if (/\b[Oo]pen[\s-]*[Cc]ollector\b/i.test(text)) kw.push("open-collector");
  if (/\b[Tt]ri[\s-]*[Ss]tate\b|\b3[\s-]*[Ss]tate\b/i.test(text)) kw.push("tri-state");
  if (/\b[Bb]idirectional\b/i.test(text)) kw.push("bidirectional");
  if (/\b[Uu]nidirectional\b/i.test(text)) kw.push("unidirectional");
  if (/\b[Ll]evel[\s-]*[Ss]hifter/i.test(text)) kw.push("level-shifter");
  if (/\b[Ff]lip[\s-]*[Ff]lop\b|\bD[\s-]*[Tt]ype\b/i.test(text)) kw.push("flip-flop");
  if (/\b[Ll]atch\b/i.test(text)) kw.push("latch");
  if (/\b[Mm]ultiplexer\b|\bMUX\b/i.test(text)) kw.push("multiplexer");
  if (/\b[Dd]emultiplexer\b|\bDEMUX\b/i.test(text)) kw.push("demultiplexer");
  if (/\b[Dd]ecoder\b/i.test(text)) kw.push("decoder");
  if (/\b[Ee]ncoder\b/i.test(text)) kw.push("encoder");
  if (/\b[Cc]ounter\b|\b[Dd]ivider\b/i.test(text)) kw.push("counter");
  if (/\b[Ss]hift\s*[Rr]egister\b/i.test(text)) kw.push("shift-register");
  if (/\bFIFO\b/i.test(text)) kw.push("fifo");
  if (/\b[Mm]onostable\b/i.test(text)) kw.push("monostable");

  return [...new Set(kw)];
}


// ── Power Module / PMIC extractors ──

function extractPowerProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // ── Input voltage range (Vin) ──
  let vinMin = Infinity, vinMax = 0;

  // Pattern 1: "Xv to Yv" near VIN / input voltage context
  const vinRangeRe = /(?:V\s*IN|input\s*voltage\s*(?:range)?|supply\s*(?:input\s*)?voltage|operating\s*input\s*(?:range|voltage)|输入电压)\s*(?:range)?\s*[:=]?\s*(\d+\.?\d*)\s*V?\s*(?:to|~|\.\.\.?|-|–|—)\s*(\d+\.?\d*)\s*V/gi;
  while ((m = vinRangeRe.exec(text)) !== null) {
    const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
    // Skip AC mains ranges (85-265V is AC input, not DC)
    const ctx = text.substring(Math.max(0, m.index - 30), m.index + m[0].length + 10);
    if (/\bAC\b/.test(ctx)) continue;
    if (hi > lo && lo >= 0.5 && hi <= 1000 && (hi - lo) > (vinMax - vinMin)) { vinMin = lo; vinMax = hi; }
  }

  // Pattern 2: Feature bullet "X.XV-to-Y.YV Operating Input Range"
  if (vinMax <= vinMin) {
    const featVinRe = /(\d+\.?\d*)\s*V?\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*V\s*(?:Operating\s*)?(?:Input|Supply)\s*(?:Voltage\s*)?(?:Range)?/gi;
    while ((m = featVinRe.exec(text)) !== null) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (hi > lo && lo >= 0.5 && hi <= 1000 && (hi - lo) > (vinMax - vinMin)) { vinMin = lo; vinMax = hi; }
    }
  }

  // Pattern 3: Chinese parenthetical ranges "(4.5-5.5)" or "（10.8~13.2）" near 输入电压
  if (vinMax <= vinMin) {
    const zhVinRe = /(?:输入电压|标称值|范围值)\s*[^(（]*?[（(](\d+\.?\d*)\s*[~\-–—]\s*(\d+\.?\d*)[）)]/g;
    while ((m = zhVinRe.exec(text)) !== null) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (hi > lo && lo >= 0.5 && hi <= 1000 && (hi - lo) > (vinMax - vinMin)) { vinMin = lo; vinMax = hi; }
    }
  }

  // Pattern 3b: Scan table rows for parenthetical voltage ranges like "（4.5-5.5）" or "(10.8~13.2)"
  if (vinMax <= vinMin) {
    const tableText = source === "datasheet" ? text.substring(0, 5000) : text;
    const parenRangeRe = /[（(](\d+\.?\d*)\s*[~\-–—]\s*(\d+\.?\d*)[）)]/g;
    while ((m = parenRangeRe.exec(tableText)) !== null) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      // Must look like a voltage range (both in reasonable Vin range)
      if (hi > lo && lo >= 1 && hi <= 200 && hi / lo < 5 && (hi - lo) > (vinMax - vinMin)) {
        vinMin = lo; vinMax = hi;
      }
    }
  }

  // Pattern 4: Recommended operating conditions table — "VIN ... 6 ... 20 V"
  if (vinMax <= vinMin) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/(?:V\s*IN\b|Input\s*[Vv]oltage|Supply\s*[Vv]oltage|Operating\s*[Ii]nput|input\s*voltage\s*range\s*after)/i.test(line)) continue;
      // Skip pin descriptions, absolute max lines, differential voltage lines
      if (/pin\b|引脚|管脚|Differential|Input.to.Output/i.test(line)) continue;
      // Extract min/max pair: look for numbers followed by V unit in the line
      // Only count numbers followed by V (not %, ppm, °C, mA, etc.)
      const vNums = [...line.matchAll(/(\d+\.?\d*)\s*V\b/g)].map(n => parseFloat(n[1])).filter(v => v >= 0.5 && v <= 200);
      if (vNums.length >= 2) {
        const sorted = [...new Set(vNums)].sort((a, b) => a - b);
        if (sorted.length >= 2) {
          const lo = sorted[0], hi = sorted[sorted.length - 1];
          if (hi > lo && hi <= 200 && (hi - lo) > (vinMax - vinMin)) { vinMin = lo; vinMax = hi; }
        }
      }
    }
  }

  if (vinMax > vinMin && vinMax <= 1000) {
    props.push({ key: "vin_min", value: vinMin, unit: "V", source });
    props.push({ key: "vin_max", value: vinMax, unit: "V", source });
  }

  // ── Output voltage (Vout) ──
  let voutMin = Infinity, voutMax = 0;

  const voutRangeRe = /(?:V\s*OUT|output\s*voltage\s*(?:range)?|输出电压)\s*(?:range)?\s*[:=]?\s*(\d+\.?\d*)\s*V?\s*(?:to|~|\.\.\.?|-|–|—)\s*(\d+\.?\d*)\s*V/gi;
  while ((m = voutRangeRe.exec(text)) !== null) {
    const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
    // Skip AC mains ranges
    const voutCtx = text.substring(Math.max(0, m.index - 30), m.index + m[0].length + 10);
    if (/\bAC\b/.test(voutCtx)) continue;
    if (hi > lo && lo >= 0 && hi <= 500 && (hi - lo) > (voutMax - voutMin)) { voutMin = lo; voutMax = hi; }
  }

  if (voutMax <= voutMin) {
    const adjRe = /output\s*(?:voltage\s*)?(?:adjustable|programmable)\s*(?:from|down\s*to)\s*(\d+\.?\d*)\s*V/gi;
    while ((m = adjRe.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0 && v < 50) { voutMin = v; break; }
    }
  }

  if (voutMax <= voutMin && voutMin === Infinity) {
    const fixedVoutRe = /(?:Output\s*Voltage|V\s*OUT)\s*[:=]?\s*(\d+\.?\d*)\s*V\b/gi;
    const vouts: number[] = [];
    while ((m = fixedVoutRe.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0 && v < 100) vouts.push(v);
    }
    if (vouts.length > 0) {
      const counts = new Map<number, number>();
      for (const v of vouts) counts.set(v, (counts.get(v) ?? 0) + 1);
      let best = vouts[0], bestN = 0;
      for (const [v, n] of counts) { if (n > bestN) { best = v; bestN = n; } }
      voutMin = best;
    }
  }

  if (voutMax > voutMin) {
    props.push({ key: "vout_min", value: voutMin, unit: "V", source });
    props.push({ key: "vout_max", value: voutMax, unit: "V", source });
  } else if (voutMin < Infinity && voutMin > 0) {
    props.push({ key: "vout", value: voutMin, unit: "V", source });
  }

  // ── Output current (Iout max) ──
  let iout = 0;

  const ioutPatterns = [
    /(\d+\.?\d*)\s*-?\s*A\s*(?:Continuous\s*(?:Load\s*)?(?:Output\s*)?Current|Output\s*Current|Load\s*Current)/gi,
    /Up\s*to\s*(\d+\.?\d*)\s*-?\s*A\s*(?:Output|Load)/gi,
    /(?:(?:Continuous|Max(?:imum)?|Output)\s*(?:Load\s*)?(?:Output\s*)?Current|I\s*OUT\s*(?:\(max\))?|输出电流)\s*[:=]?\s*(\d+\.?\d*)\s*(m?)\s*A/gi,
  ];
  for (const re of ioutPatterns) {
    while ((m = re.exec(text)) !== null) {
      const milli = m[2] === "m" ? 0.001 : 1;
      const val = parseFloat(m[1]) * milli;
      if (val > 0 && val <= 200) { iout = val; break; }
    }
    if (iout > 0) break;
  }

  if (iout === 0) {
    const ioutP = scanSpecRow(text, /(?:Output\s*Current|Load\s*Current|I\s*OUT\b|I\s*O\b)/i,
      (v) => v > 0 && v <= 200, "iout_max", "A", source);
    if (ioutP) iout = ioutP.value;
  }

  if (iout > 0) props.push({ key: "iout_max", value: iout, unit: "A", source });

  // ── Efficiency (%) ──
  let bestEff = 0;

  const effPatterns = [
    /(?:efficiency|效率|η)\s*(?:up\s*to|高达|达到|达)?\s*[:=]?\s*(\d{2,3}(?:\.\d+)?)\s*%/gi,
    /(\d{2,3}(?:\.\d+)?)\s*%\s*(?:efficiency|peak\s*efficiency)/gi,
    /(?:Peak|Max(?:imum)?|Full[\s-]?[Ll]oad)\s*[Ee]fficiency\s*[:=]?\s*(\d{2,3}(?:\.\d+)?)\s*%?/gi,
  ];
  for (const re of effPatterns) {
    while ((m = re.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 50 && v < 100 && v > bestEff) bestEff = v;
    }
  }

  if (bestEff === 0) {
    const effP = scanSpecRow(text, /(?:[Ee]fficiency|效率|η\b)/i,
      (v) => v > 50 && v < 100, "efficiency", "%", source);
    if (effP) bestEff = effP.value;
  }

  if (bestEff > 50) props.push({ key: "efficiency", value: bestEff, unit: "%", source });

  // ── Quiescent current (Iq / Idd) ──
  let iqVal = 0;
  let iqUnit = "A";

  const iqPatterns = [
    /(?:Quiescent|Standby|No[\s-]?Load|静态)\s*(?:Supply\s*)?(?:Current|电流)\s*[:=]?\s*(\d+\.?\d*)\s*([uμµn]|m)?\s*A/gi,
    /I\s*[Qq]\s*[:=]?\s*(\d+\.?\d*)\s*([uμµn]|m)?\s*A/g,
    /(\d+\.?\d*)\s*([uμµn]|m)\s*A\s*(?:Low\s*)?(?:Quiescent|Standby|No[\s-]*Load|I[Qq])/gi,
  ];
  for (const re of iqPatterns) {
    while ((m = re.exec(text)) !== null) {
      const prefix = m[2];
      const mult = (prefix === "u" || prefix === "μ" || prefix === "µ") ? 1e-6 : prefix === "n" ? 1e-9 : prefix === "m" ? 1e-3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0 && val < 0.1) {
        if (iqVal === 0 || val < iqVal) { iqVal = val; }
      }
    }
    if (iqVal > 0) break;
  }

  if (iqVal === 0) {
    const iqP = scanSpecRow(text, /(?:Quiescent\s*Current|I\s*[Qq]\b|Supply\s*Current\s*\(Quiescent\))/i,
      (v) => v > 0 && v < 500, "iq", "uA", source);
    if (iqP) { iqVal = iqP.value * 1e-6; iqUnit = "A"; }
  }

  if (iqVal > 0) {
    const valA = iqUnit === "uA" ? iqVal * 1e-6 : iqUnit === "mA" ? iqVal * 1e-3 : iqVal;
    if (valA > 1e-12 && valA < 0.01) props.push({ key: "iq", value: valA, unit: "A", source });
  }

  // ── Switching frequency (fsw) ──
  let fsw = 0;

  const fswPatterns = [
    /(?:switching|oscillator|开关|operating)\s*(?:frequency|频率|freq)\s*[:=]?\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*Hz/gi,
    /f\s*(?:SW|OSC|s)\s*[:=]?\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*Hz/g,
    /(\d+\.?\d*)\s*(k|K|M|G)?\s*Hz\s*(?:switching|oscillator|operating)\s*(?:frequency)?/gi,
    /(?:Fixed|Nominal)\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*Hz\s*(?:frequency)?/gi,
  ];
  for (const re of fswPatterns) {
    while ((m = re.exec(text)) !== null) {
      const prefix = m[2];
      const mult = (prefix === "G") ? 1e9 : (prefix === "M") ? 1e6 : (prefix === "k" || prefix === "K") ? 1e3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val >= 10e3 && val <= 100e6 && val > fsw) fsw = val;
    }
  }

  if (fsw > 0) props.push({ key: "fsw", value: fsw, unit: "Hz", source });

  // ── Dropout voltage (LDOs) — only extract when text mentions dropout/LDO context ──
  // Only extract dropout for parts that are actually LDOs (not just mentioning internal LDO)
  const headerText = source === "datasheet" ? text.substring(0, 2000) : text;
  const isLDO = (/\bLDO\b/i.test(headerText) && !/\bInternal\s*LDO\b/i.test(headerText)) ||
                /\blow.?dropout\s*(?:regulator|voltage)/i.test(headerText) ||
                /dropout\s*voltage/i.test(text);
  if (!isLDO) {
    // skip dropout extraction for non-LDO parts
  } else {
  const vdropPatterns = [
    /(?:Dropout\s*Voltage|V\s*DROP|V\s*DO)\s*[:=]?\s*(\d+\.?\d*)\s*(m?)\s*V/gi,
    /(?:maximum\s*dropout|dropout)\s*(?:of\s*)?\s*(\d+\.?\d*)\s*(m?)\s*V/gi,
  ];
  for (const re of vdropPatterns) {
    while ((m = re.exec(text)) !== null) {
      const milli = m[2] === "m" ? 0.001 : 1;
      const val = parseFloat(m[1]) * milli;
      if (val > 0 && val <= 10) { props.push({ key: "vdrop", value: val, unit: "V", source }); break; }
    }
    if (props.some((p) => p.key === "vdrop")) break;
  }

  if (!props.some((p) => p.key === "vdrop")) {
    // Scan for dropout voltage in spec table rows, skipping note references
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/(?:Dropout\s*Voltage|V\s*DROP\b|V\s*DO\b)/i.test(line)) continue;
      // Clean the line: strip (Note N), test conditions
      const cleaned = line
        .replace(/\([Nn]ote\s*\d+\)/g, "")
        .replace(/[A-Z]{1,4}\s*=\s*-?\d+\.?\d*\s*[a-zA-Zμµ°℃]*/g, "");
      const nums = [...cleaned.matchAll(/(?<!\.)\b(\d+\.\d+)\b/g)];
      for (const nm of nums) {
        const val = parseFloat(nm[1]);
        if (val > 0 && val < 5) { props.push({ key: "vdrop", value: val, unit: "V", source }); break; }
      }
      if (props.some((p) => p.key === "vdrop")) break;
      // Also check next 2 lines for the value
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const nextCleaned = lines[j].replace(/[A-Z]{1,4}\s*=\s*-?\d+\.?\d*\s*[a-zA-Zμµ°℃]*/g, "");
        const nextNums = [...nextCleaned.matchAll(/(?<!\.)\b(\d+\.\d+)\b/g)];
        for (const nm of nextNums) {
          const val = parseFloat(nm[1]);
          if (val > 0 && val < 5) { props.push({ key: "vdrop", value: val, unit: "V", source }); break; }
        }
        if (props.some((p) => p.key === "vdrop")) break;
      }
      if (props.some((p) => p.key === "vdrop")) break;
    }
  }
  } // end isLDO check

  // ── Isolation voltage (isolated modules) ──
  const isoPatterns = [
    /(?:Isolation|隔离|Insulation)\s*(?:Voltage|电压)\s*[:=]?\s*(\d+\.?\d*)\s*(K|k)?\s*V\s*(?:DC|dc|rms|AC)?/gi,
    /(\d+\.?\d*)\s*(K|k)?\s*V\s*(?:DC|dc)?\s*(?:Isolation|隔离|isolation\s*voltage)/gi,
  ];
  for (const re of isoPatterns) {
    while ((m = re.exec(text)) !== null) {
      const mult = (m[2] === "K" || m[2] === "k") ? 1000 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val >= 100 && val <= 20000) { props.push({ key: "isolation_voltage", value: val, unit: "V", source }); break; }
    }
    if (props.some((p) => p.key === "isolation_voltage")) break;
  }

  if (!props.some((p) => p.key === "isolation_voltage")) {
    const isoP = scanSpecRow(text, /(?:Isolation\s*Voltage|隔离电压|绝缘电压|Insulation\s*Voltage|Hi[\s-]?Pot)/i,
      (v) => v >= 100 && v <= 20000, "isolation_voltage", "V", source);
    if (isoP) props.push(isoP);
  }

  // ── Output power (AC-DC controllers) ──
  const poutPatterns = [
    /(?:Output\s*(?:Max(?:imum)?\s*)?Power|Max(?:imum)?\s*(?:Output\s*)?Power|输出(?:最大)?功率)\s*[:=：]?\s*(\d+\.?\d*)\s*W/gi,
    /(\d+\.?\d*)\s*W\s*(?:Output\s*Power|Maximum\s*(?:Output\s*)?Power|最大功率)/gi,
  ];
  for (const re of poutPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 10000) { props.push({ key: "output_power", value: val, unit: "W", source }); break; }
    }
    if (props.some((p) => p.key === "output_power")) break;
  }

  return props;
}

function extractPowerKeywords(text: string): string[] {
  const kw: string[] = [];

  // Topology keywords
  if (/\bbuck\b(?!\s*-?\s*boost)/i.test(text) || /\bstep[\s-]?down\b|降压/i.test(text)) kw.push("buck");
  if (/\bboost\b(?<!\bbuck[\s-]?)/i.test(text) || /\bstep[\s-]?up\b|升压/i.test(text)) kw.push("boost");
  if (/\bbuck[\s-]?boost\b|升降压/i.test(text)) kw.push("buck-boost");
  if (/\bLDO\b|\blow[\s-]?dropout\b/i.test(text)) kw.push("ldo");
  if (/\bflyback\b|反激/i.test(text)) kw.push("flyback");
  if (/\bforward\b(?!\s*(?:voltage|current|bias))/i.test(text)) kw.push("forward");
  if (/\bhalf[\s-]?bridge\b|半桥/i.test(text)) kw.push("half-bridge");
  if (/\bfull[\s-]?bridge\b|全桥/i.test(text)) kw.push("full-bridge");
  if (/\bpush[\s-]?pull\b|推挽/i.test(text)) kw.push("push-pull");
  if (/\bSEPIC\b/i.test(text)) kw.push("sepic");
  if (/\bCuk\b|\bĆuk\b/i.test(text)) kw.push("cuk");
  if (/\bcharge[\s-]?pump\b|电荷泵/i.test(text)) kw.push("charge-pump");
  if (/\binverting\b(?!\s*input)/i.test(text)) kw.push("inverting");

  // Isolation
  if (/\bisolat(?:ed|ion)\b|隔离/i.test(text)) kw.push("isolated");
  if (/\bnon[\s-]?isolat/i.test(text) || /非隔离/i.test(text)) kw.push("non-isolated");

  // Regulation mode
  if (/\bsynchronous\b|同步/i.test(text)) kw.push("synchronous");
  if (/\basynchronous\b|非同步/i.test(text)) kw.push("asynchronous");
  if (/\b(?:internal|integrated|built[\s-]?in)\s*(?:power\s*)?MOSFET/i.test(text) ||
      /内置.*MOS|集成.*MOS/i.test(text)) kw.push("integrated-mosfet");
  if (/\bexternal\s*(?:power\s*)?MOSFET/i.test(text)) kw.push("external-mosfet");

  // Control mode
  if (/\bPWM\b/i.test(text)) kw.push("pwm");
  if (/\bPFM\b/i.test(text)) kw.push("pfm");
  if (/\bcurrent[\s-]?mode\b|电流模式/i.test(text)) kw.push("current-mode");
  if (/\bvoltage[\s-]?mode\b|电压模式/i.test(text)) kw.push("voltage-mode");
  if (/\bpeak[\s-]?current[\s-]?mode/i.test(text)) kw.push("peak-current-mode");

  // Feature keywords
  if (/\bsoft[\s-]?start\b|软启动/i.test(text)) kw.push("soft-start");
  if (/\benable\b|\bshutdown\b/i.test(text)) kw.push("enable");
  if (/\bpower[\s-]?good\b|\bPGOOD\b|电源正常/i.test(text)) kw.push("power-good");
  if (/\bUVLO\b|\bunder[\s-]?voltage\s*lock[\s-]?out\b|欠压锁定/i.test(text)) kw.push("uvlo");
  if (/\bOVP\b|\bover[\s-]?voltage\s*protection\b|过压保护/i.test(text)) kw.push("ovp");
  if (/\bOCP\b|\bover[\s-]?current\s*protection\b|过流保护|过载保护/i.test(text)) kw.push("ocp");
  if (/\bthermal\s*shutdown\b|\bOTP\b|过温保护|过热保护/i.test(text)) kw.push("thermal-shutdown");
  if (/\bspread[\s-]?spectrum\b|展频/i.test(text)) kw.push("spread-spectrum");
  if (/\b(?:frequency|freq)[\s-]?sync(?:hroniz)?/i.test(text) || /\bSYNC\b/.test(text)) kw.push("sync");
  if (/\bintegrated\s*inductor\b|内置电感/i.test(text)) kw.push("integrated-inductor");

  // Application type
  if (/\bPOL\b|\bpoint[\s-]?of[\s-]?load\b/i.test(text)) kw.push("pol");
  if (/\bDDR\b/i.test(text)) kw.push("ddr");
  if (/\bIGBT\s*(?:driver|gate|驱动)/i.test(text)) kw.push("igbt-driver");
  if (/\bPoE\b|\bPower[\s-]?over[\s-]?Ethernet\b/i.test(text)) kw.push("poe");

  return [...new Set(kw)];
}

// ── Filter extractors (Ferrite Beads, Common Mode, SAW, EMI/RFI) ──

function extractFilterProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  const isFerrite = /\bferrite\s*bead\b|\bchip\s*bead\b|\bchip\s*ferrite\b|铁氧体磁珠|磁珠/i.test(text);
  const isCommonMode = /\bcommon\s*mode\b|共模/i.test(text);
  const isSAW = /\bSAW\s*filter\b|\bsurface\s*acoustic\b/i.test(text);
  const isCeramic = /\bceramic\s*filter\b|陶瓷滤波/i.test(text);
  const isEMI = /\bEMI\b|\bRFI\b|\bline\s*filter\b|\bEMC\b|\bnoise\s*filter\b/i.test(text);
  const isLowPass = /\blow[\s-]*pass\b/i.test(text);
  const isBandPass = /\bband[\s-]*pass\b/i.test(text);
  const isHighPass = /\bhigh[\s-]*pass\b/i.test(text);
  // ── Impedance@frequency — ferrite beads & common mode ──
  const impInlinePatterns = [
    /(?:impedance|Z)\s*[:=]?\s*(\d+\.?\d*)\s*(?:Ω|Ohm|ohm)\s*[@(]\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*H?\s*[Zz]/gi,
    /(\d+\.?\d*)\s*(?:Ω|Ohm|ohm)\s*[@(]\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*H?\s*[Zz]/gi,
    /(?:impedance|Z)\s*[:=]?\s*(\d+\.?\d*)\s*(?:MIN\s*)?(?:Ω|Ohm|OHM)\s*\(\s*(\d+\.?\d*)\s*(M|K|G)?\s*H?\s*Z\s*\)/gi,
    /Z\s*:\s*(\d+\.?\d*)\s*MIN\s*OHM\s*\(\s*(\d+\.?\d*)\s*(M|K|G)?H?Z\s*\)/gi,
  ];
  for (const re of impInlinePatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 100000) {
        props.push({ key: "impedance", value: val, unit: "Ohm", source });
        const freqRaw = parseFloat(m[2]);
        const prefix = (m[3] || "").toUpperCase();
        const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
        const freq = freqRaw * mult;
        if (freq > 0) props.push({ key: "test_frequency", value: freq, unit: "Hz", source });
        break;
      }
    }
    if (props.some((p) => p.key === "impedance")) break;
  }
  if (!props.some((p) => p.key === "impedance") && (isFerrite || isCommonMode)) {
    const impP = scanSpecRow(text, /(?:Impedance|标称阻抗|阻抗)\s*(?:\([^)]*\))?/i, (v) => v > 0 && v <= 100000, "impedance", "Ohm", source);
    if (impP) props.push(impP);
  }
  if (!props.some((p) => p.key === "impedance") && (isFerrite || isCommonMode)) {
    const tableProps = scanTable(text, [
      { pattern: /\bImpedance\b|标称阻抗/i, key: "impedance", unit: "Ohm" },
      { pattern: /\bDCR\b|\bRDC\b|直流电阻/i, key: "dcr", unit: "Ohm" },
      { pattern: /\bRated\s*[Cc]urrent\b|\bIr\b|额定电流/i, key: "rated_current", unit: "mA" },
    ], source);
    const existing = new Set(props.map((p) => p.key));
    for (const tp of tableProps) { if (!existing.has(tp.key)) props.push(tp); }
  }
  // ── DC Resistance (DCR / RDC) ──
  if (!props.some((p) => p.key === "dcr")) {
    const dcrRe = /(?:DCR|RDC|DC\s*Resistance|直流电阻)\s*(?:\([^)]*\))?\s*[:=<≤]?\s*(\d+\.?\d*)\s*(m?)\s*(?:Ω|Ohm|ohm)/gi;
    while ((m = dcrRe.exec(text)) !== null) {
      const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
      if (val >= 0 && val < 1000) { props.push({ key: "dcr", value: val, unit: "Ohm", source }); break; }
    }
  }
  if (!props.some((p) => p.key === "dcr") && (isFerrite || isCommonMode)) {
    const dcrP = scanSpecRow(text, /(?:DCR|RDC|DC\s*Resist|直流电阻)/i, (v) => v >= 0 && v < 10000, "dcr", "Ohm", source);
    if (dcrP) props.push(dcrP);
  }
  // ── Rated Current ──
  if (!props.some((p) => p.key === "rated_current")) {
    const rcPatterns = [
      /(?:Rated\s*[Cc]urrent|额定电流|Ir|IDC)\s*(?:\([^)]*\))?\s*[:=]?\s*(\d+\.?\d*)\s*(m?)\s*A/gi,
      /(?:Temperature\s*Rise\s*Current)\s*(?:\([^)]*\))?\s*[:=]?\s*(\d+\.?\d*)\s*(m?)\s*A/gi,
    ];
    for (const re of rcPatterns) {
      while ((m = re.exec(text)) !== null) {
        const val = parseFloat(m[1]) * (m[2] === "m" ? 0.001 : 1);
        if (val > 0 && val <= 100) { props.push({ key: "rated_current", value: val, unit: "A", source }); break; }
      }
      if (props.some((p) => p.key === "rated_current")) break;
    }
  }
  if (!props.some((p) => p.key === "rated_current") && (isFerrite || isCommonMode)) {
    const rcP = scanSpecRow(text, /(?:Rated\s*[Cc]urrent|额定电流|Ir\b|IDC\b|Temp.*Rise.*Current)/i, (v) => v > 0 && v < 100000, "rated_current", "mA", source);
    if (rcP) props.push(rcP);
  }
  // ── Inductance — common mode ──
  if (isCommonMode && !props.some((p) => p.key === "inductance")) {
    const indRe = /(?:Inductance|感值|电感量)\s*[:=]?\s*(\d+\.?\d*)\s*(n|u|μ|µ|m)?\s*H/gi;
    while ((m = indRe.exec(text)) !== null) {
      const prefix = (m[2] || "").toLowerCase();
      const mult = prefix === "m" ? 1e-3 : (prefix === "u" || prefix === "μ" || prefix === "µ") ? 1e-6 : prefix === "n" ? 1e-9 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0) { props.push({ key: "inductance", value: val, unit: "H", source }); break; }
    }
  }
  // ── Center Frequency — SAW / Ceramic / bandpass ──
  if (isSAW || isCeramic || isBandPass) {
    const cfRe = /(?:Center\s*Frequency|中心频率)\s*[:=]?\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*H?\s*[Zz]/gi;
    while ((m = cfRe.exec(text)) !== null) {
      const prefix = (m[2] || "").toUpperCase();
      const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0) { props.push({ key: "center_frequency", value: val, unit: "Hz", source }); break; }
    }
    if (!props.some((p) => p.key === "center_frequency")) {
      const cfP = scanSpecRow(text, /(?:Center\s*Frequency|中心频率)/i, (v) => v > 0 && v < 100000, "center_frequency", "MHz", source);
      if (cfP) props.push({ key: "center_frequency", value: cfP.value * 1e6, unit: "Hz", source });
    }
  }
  // ── Insertion Loss ──
  if (isSAW || isCeramic || isLowPass || isBandPass || isEMI) {
    const ilRe = /(?:Insertion\s*Loss)\s*(?:\([^)]*\))?\s*[:=<≤]?\s*(?:[-–]?\s*)?(\d+\.?\d*)\s*dB/gi;
    while ((m = ilRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val < 30) { props.push({ key: "insertion_loss", value: val, unit: "dB", source }); break; }
    }
    if (!props.some((p) => p.key === "insertion_loss")) {
      const ilP = scanSpecRow(text, /(?:Insertion\s*Loss|插入损耗)/i, (v) => v > 0 && v < 30, "insertion_loss", "dB", source);
      if (ilP) props.push(ilP);
    }
  }
  // ── Bandwidth — SAW / bandpass ──
  if (isSAW || isBandPass) {
    const bwRe = /(?:passband|bandwidth|3\s*dB\s*bandwidth|通带宽度)\s*[:=]?\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*H?\s*[Zz]/gi;
    while ((m = bwRe.exec(text)) !== null) {
      const prefix = (m[2] || "").toUpperCase();
      const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0) { props.push({ key: "bandwidth", value: val, unit: "Hz", source }); break; }
    }
  }
  // ── Cutoff Frequency — low-pass / high-pass / EMI ──
  if (isLowPass || isHighPass || isEMI) {
    const cutRe = /(?:cutoff\s*frequency|cut[\s-]*off\s*freq|[-–]3\s*dB\s*(?:frequency|point)|截止频率)\s*[:=]?\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*H?\s*[Zz]/gi;
    while ((m = cutRe.exec(text)) !== null) {
      const prefix = (m[2] || "").toUpperCase();
      const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0) { props.push({ key: "cutoff_frequency", value: val, unit: "Hz", source }); break; }
    }
  }
  // ── Rated Voltage — common mode / EMI ──
  if (!props.some((p) => p.key === "rated_voltage") && (isCommonMode || isEMI)) {
    const rvP = scanSpecRow(text, /(?:Rated\s*[Vv]oltage|额定电压|Working\s*Voltage)/i, (v) => v > 0 && v <= 10000, "rated_voltage", "V", source);
    if (rvP) props.push(rvP);
  }
  // ── VSWR — SAW / bandpass ──
  if (isSAW || isBandPass) {
    const vswrP = scanSpecRow(text, /\bVSWR\b|(?:Input|Output)\s*VSWR/i, (v) => v > 1 && v < 10, "vswr", "", source);
    if (vswrP) props.push(vswrP);
  }
  return props;
}

function extractFilterKeywords(text: string): string[] {
  const kw: string[] = [];
  if (/\bferrite\s*bead\b|\bchip\s*bead\b|铁氧体磁珠|磁珠/i.test(text)) kw.push("ferrite-bead");
  if (/\bcommon\s*mode\b|共模/i.test(text)) kw.push("common-mode");
  if (/\bSAW\b|\bsurface\s*acoustic\b/i.test(text)) kw.push("saw");
  if (/\bceramic\s*filter\b|陶瓷滤波/i.test(text)) kw.push("ceramic-filter");
  if (/\bEMI\b/i.test(text)) kw.push("emi");
  if (/\bRFI\b/i.test(text)) kw.push("rfi");
  if (/\bEMC\b/i.test(text)) kw.push("emc");
  if (/\blow[\s-]*pass\b/i.test(text)) kw.push("low-pass");
  if (/\bhigh[\s-]*pass\b/i.test(text)) kw.push("high-pass");
  if (/\bband[\s-]*pass\b/i.test(text)) kw.push("band-pass");
  if (/\bnotch\b|\bband[\s-]*stop\b/i.test(text)) kw.push("notch");
  if (/\bmultilayer\b|叠层/i.test(text)) kw.push("multilayer");
  if (/\bhigh[\s-]*current\b|大电流/i.test(text)) kw.push("high-current");
  if (/\bCAN[\s-]*BUS\b/i.test(text)) kw.push("can-bus");
  if (/\bFlexRay\b/i.test(text)) kw.push("flexray");
  if (/\bautomotive\b/i.test(text)) kw.push("automotive");
  if (/\bpower\s*(?:line|supply)\b/i.test(text)) kw.push("power-line");
  if (/\bsignal\s*line\b/i.test(text)) kw.push("signal-line");
  return [...new Set(kw)];
}

// ── RF / Wireless extractors ──

function extractRFProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;
  const isTransceiver = /\btransceiver\b|\bSoC\b|\bsystem[\s-]*on[\s-]*chip\b/i.test(text);
  const isAmplifier = /\bamplifier\b|\bLNA\b|\bPA\b|\bpower\s*amp/i.test(text);
  const isFrontEnd = /\bfront[\s-]*end\b|\bFEM\b/i.test(text);
  const isBalun = /\bbalun\b/i.test(text);
  const isSwitch = /\bRF\s*switch\b/i.test(text);
  const isAttenuator = /\battenuator\b/i.test(text);
  // ── TX Power (dBm) ──
  const txPwrPatterns = [
    /(?:TX\s*power|output\s*power|transmit\s*power)\s*[:=]?\s*(?:up\s*to\s*)?[+]?\s*(\d+\.?\d*)\s*dBm/gi,
    /[+](\d+\.?\d*)\s*dBm\s*(?:TX|output)\s*power/gi,
    /@\s*[+]?(\d+\.?\d*)\s*dBm/gi,
  ];
  for (const re of txPwrPatterns) {
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 0 && val <= 40) { props.push({ key: "tx_power_dbm", value: val, unit: "dBm", source }); break; }
    }
    if (props.some((p) => p.key === "tx_power_dbm")) break;
  }
  // ── RX Sensitivity (dBm) ──
  if (isTransceiver || isFrontEnd) {
    const rxPatterns = [
      /(?:sensitivity|RX\s*sensitivity)\s*[:=]?\s*[-–]?\s*(\d+\.?\d*)\s*dBm/gi,
      /[-–](\d+\.?\d*)\s*dBm\s*(?:sensitivity|RX)/gi,
    ];
    for (const re of rxPatterns) {
      while ((m = re.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        if (val >= 50 && val <= 130) { props.push({ key: "rx_sensitivity_dbm", value: -val, unit: "dBm", source }); break; }
      }
      if (props.some((p) => p.key === "rx_sensitivity_dbm")) break;
    }
  }
  // ── Gain (dB) ──
  if (isAmplifier || isFrontEnd || isBalun) {
    const gainRe = /(?:gain|power\s*gain)\s*[:=]?\s*(\d+\.?\d*)\s*dB(?!m)/gi;
    while ((m = gainRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 80) { props.push({ key: "gain", value: val, unit: "dB", source }); break; }
    }
  }
  // ── Noise Figure (dB) ──
  if (isAmplifier || isFrontEnd) {
    const nfRe = /(?:noise\s*figure|NF)\s*[:=<≤]?\s*(\d+\.?\d*)\s*dB/gi;
    while ((m = nfRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val > 0 && val < 20) { props.push({ key: "noise_figure", value: val, unit: "dB", source }); break; }
    }
  }
  // ── Frequency Range (Hz) ──
  const freqRangeRe = /(?:(?:operating\s*)?frequency\s*(?:range)?|freq[\s.]*range)\s*[:=]?\s*(\d+\.?\d*)\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*(k|K|M|G)?\s*H?\s*[Zz]/gi;
  while ((m = freqRangeRe.exec(text)) !== null) {
    const prefix = (m[3] || "").toUpperCase();
    const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
    const lo = parseFloat(m[1]) * mult;
    const hi = parseFloat(m[2]) * mult;
    if (hi > lo && lo > 0 && hi <= 100e9) {
      props.push({ key: "freq_min", value: lo, unit: "Hz", source });
      props.push({ key: "freq_max", value: hi, unit: "Hz", source });
      break;
    }
  }
  if (!props.some((p) => p.key === "freq_min")) {
    const singleFreqRe = /(\d+\.?\d*)\s*(G|M|K)\s*Hz\s*(?:Wi[\s-]*Fi|radio|transceiver|receiver|transmitter|RF)/gi;
    while ((m = singleFreqRe.exec(text)) !== null) {
      const prefix = m[2].toUpperCase();
      const mult = prefix === "G" ? 1e9 : prefix === "M" ? 1e6 : prefix === "K" ? 1e3 : 1;
      const val = parseFloat(m[1]) * mult;
      if (val > 0) { props.push({ key: "operating_frequency", value: val, unit: "Hz", source }); break; }
    }
  }
  // ── Supply Voltage — transceivers ──
  if (isTransceiver) {
    const vsupRe = /(?:V[CcDd][CcDd]|supply\s*voltage|operating\s*voltage)\s*[:=]?\s*(\d+\.?\d*)\s*(?:V)?\s*(?:to|~|-|–|—)\s*(\d+\.?\d*)\s*V/gi;
    while ((m = vsupRe.exec(text)) !== null) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (hi > lo && hi <= 7 && lo >= 0.5) { props.push({ key: "vcc_min", value: lo, unit: "V", source }); props.push({ key: "vcc_max", value: hi, unit: "V", source }); break; }
    }
  }
  // ── Impedance — standard RF (50/75 Ω) ──
  if (/\b50\s*(?:Ω|Ohm|ohm)\b/i.test(text)) props.push({ key: "rf_impedance", value: 50, unit: "Ohm", source });
  else if (/\b75\s*(?:Ω|Ohm|ohm)\b/i.test(text)) props.push({ key: "rf_impedance", value: 75, unit: "Ohm", source });
  // ── P1dB / IP3 (amplifiers) ──
  if (isAmplifier || isFrontEnd) {
    const p1dbRe = /(?:P1dB|P[\s-]*1\s*dB)\s*[:=]?\s*[+]?\s*(\d+\.?\d*)\s*dBm/gi;
    while ((m = p1dbRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= -20 && val <= 50) { props.push({ key: "p1db", value: val, unit: "dBm", source }); break; }
    }
    const ip3Re = /(?:IP3|IIP3|OIP3)\s*[:=]?\s*[+]?\s*(\d+\.?\d*)\s*dBm/gi;
    while ((m = ip3Re.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= -20 && val <= 60) { props.push({ key: "ip3", value: val, unit: "dBm", source }); break; }
    }
  }
  return props;
}

function extractRFKeywords(text: string): string[] {
  const kw: string[] = [];
  if (/\bBluetooth\s*(?:LE|Low\s*Energy|5\.\d|4\.\d|mesh)\b/i.test(text)) kw.push("bluetooth-le");
  else if (/\bBluetooth\b/i.test(text)) kw.push("bluetooth");
  if (/\bWi[\s-]*Fi\b|\b802\.11\b/i.test(text)) kw.push("wifi");
  if (/\bZigbee\b/i.test(text)) kw.push("zigbee");
  if (/\bThread\b/.test(text)) kw.push("thread");
  if (/\bLoRa\b/i.test(text)) kw.push("lora");
  if (/\b802\.15\.4\b/i.test(text)) kw.push("802.15.4");
  if (/\bNFC\b/i.test(text)) kw.push("nfc");
  if (/\bRFID\b/i.test(text)) kw.push("rfid");
  if (/\bGNSS\b|\bGPS\b/i.test(text)) kw.push("gnss");
  if (/\bUWB\b/i.test(text)) kw.push("uwb");
  if (/\b2\.4\s*GHz\b/i.test(text)) kw.push("2.4ghz");
  if (/\b5\s*GHz\b|\b5\.8\s*GHz\b/i.test(text)) kw.push("5ghz");
  if (/\bsub[\s-]*GHz\b|\b868\s*MHz\b|\b915\s*MHz\b|\b433\s*MHz\b/i.test(text)) kw.push("sub-ghz");
  if (/\btransceiver\b/i.test(text)) kw.push("transceiver");
  if (/\bLNA\b|\blow[\s-]*noise\s*amplifier\b/i.test(text)) kw.push("lna");
  if (/\bpower\s*amplifier\b|\bPA\b/.test(text)) kw.push("pa");
  if (/\bfront[\s-]*end\b|\bFEM\b/i.test(text)) kw.push("front-end");
  if (/\bbalun\b/i.test(text)) kw.push("balun");
  if (/\bantenna\b/i.test(text)) kw.push("antenna");
  if (/\bduplexer\b|\bdiplexer\b/i.test(text)) kw.push("duplexer");
  if (/\bdirection\s*finding\b/i.test(text)) kw.push("direction-finding");
  if (/\blong[\s-]*range\b/i.test(text)) kw.push("long-range");
  return [...new Set(kw)];
}

// ── Deduplication & Main ──
// ── Audio Products extractors (Buzzers, Speakers, Microphones) ──

function extractAudioProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  const isBuzzer = /\bbuzzer\b|蜂鳴器|蜂鸣器|piezo\s*(?:audio|siren)|alarm/i.test(text);
  const isSpeaker = /\bspeaker\b|喇叭|loudspeaker|揚聲器|扬声器|woofer|tweeter/i.test(text);
  const isMic = /\bmicrophone\b|咪头|麦克风|\bMEMS\s*mic\b|\bmic\b|electret/i.test(text);

  // ── SPL — Sound Pressure Level (all audio products) ──
  const splPatterns = [
    /(?:S\.?\s*P\.?\s*L\.?|sound\s*pressure\s*level|输出音壓|输出音压|音壓位準|Output\s*S\.?P\.?L\.?)\s*[:：=]?\s*(\d+\.?\d*)\s*(?:[±+-]\s*\d+\s*)?dB/gi,
    /(\d{2,3})\s*(?:[±+-]\s*\d+\s*)?dB\s*(?:\([^)]*\))?\s*(?:at|@)/gi,
  ];
  for (const splRe of splPatterns) {
    while ((m = splRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 40 && val <= 130) { props.push({ key: "spl", value: val, unit: "dB", source }); break; }
    }
    if (props.some((p) => p.key === "spl")) break;
  }
  if (!props.some((p) => p.key === "spl")) {
    const splP = scanSpecRow(text, /(?:S\.?\s*P\.?\s*L\.?\b|Sound\s*Pressure\s*Level|音[壓压])/i,
      (v) => v >= 40 && v <= 130, "spl", "dB", source);
    if (splP) props.push(splP);
  }

  // ── Resonant/Operating Frequency (buzzers, speakers) ──
  if (isBuzzer || isSpeaker) {
    const freqPatterns = [
      /(?:Resonan[ct]e?\s*Frequency|低音諧振|諧振頻率|Operating\s*Freq(?:uency)?|操作頻率)\s*[:：=]?\s*(?:Fo\s*)?(?:\w+\s+)?(\d+\.?\d*)\s*(?:[±+-]\s*\d+\s*%?\s*)?(?:k|K)\s*H\s*z/gi,
      /(?:Resonan[ct]e?\s*Frequency|低音諧振|諧振頻率|Operating\s*Freq(?:uency)?|操作頻率)\s*[:：=]?\s*(?:Fo\s*)?(?:\w+\s+)?(\d+\.?\d*)\s*(?:[±+-]\s*\d+\s*%?\s*)?H\s*z/gi,
    ];
    for (const freqRe of freqPatterns) {
      while ((m = freqRe.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        const isKHz = /k\s*H/i.test(m[0]);
        const freq = isKHz ? val * 1000 : val;
        if (freq >= 20 && freq <= 100000) { props.push({ key: "resonant_freq", value: freq, unit: "Hz", source }); break; }
      }
      if (props.some((p) => p.key === "resonant_freq")) break;
    }
    if (!props.some((p) => p.key === "resonant_freq")) {
      const frP = scanSpecRow(text, /(?:Resonan[ct]e?\s*Freq|Operating\s*Freq|諧振|操作頻率)/i,
        (v) => v >= 20 && v <= 100000, "resonant_freq", "Hz", source);
      if (frP) props.push(frP);
    }
  }

  // ── Impedance (speakers) ──
  if (isSpeaker) {
    const impedPatterns = [
      /(?:Impedance|阻抗)\s*[:：=]?\s*(\d+\.?\d*)\s*(?:[±+-]\s*\d+\s*%?\s*)?\s*(?:Ω|ohm|Ohm)/gi,
      /(\d+\.?\d*)\s*(?:Ω|ohm)\s*(?:[±+-]\s*\d+\s*%)?/gi,
    ];
    for (const impRe of impedPatterns) {
      while ((m = impRe.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        if (val >= 1 && val <= 1000) { props.push({ key: "impedance", value: val, unit: "Ohm", source }); break; }
      }
      if (props.some((p) => p.key === "impedance")) break;
    }
    if (!props.some((p) => p.key === "impedance")) {
      const impP = scanSpecRow(text, /(?:Impedance|阻抗)/i, (v) => v >= 1 && v <= 1000, "impedance", "Ohm", source);
      if (impP) props.push(impP);
    }
  }

  // ── Power Rating (speakers) ──
  if (isSpeaker) {
    const pwrPatterns = [
      /(?:Rated|Max(?:imum)?)\s*(?:Power|功率)\s*[:：=]?\s*(\d+\.?\d*)\s*W/gi,
      /(?:Power\s*Rating|功率)\s*[:：=]?\s*(?:Rated\.?\s*)?(\d+\.?\d*)/gi,
    ];
    for (const pwrRe of pwrPatterns) {
      while ((m = pwrRe.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        if (val > 0 && val <= 1000) { props.push({ key: "power_rating", value: val, unit: "W", source }); break; }
      }
      if (props.some((p) => p.key === "power_rating")) break;
    }
    if (!props.some((p) => p.key === "power_rating")) {
      const pwrP = scanSpecRow(text, /(?:Power\s*Rating|Rated\s*Power|功率)/i,
        (v) => v > 0 && v <= 1000, "power_rating", "W", source);
      if (pwrP) props.push(pwrP);
    }
  }

  // ── Rated Voltage / Operating Voltage (buzzers) ──
  if (isBuzzer) {
    const vPatterns = [
      /(?:Rated\s*Volt(?:age)?|額定電壓|额定电压|Operating\s*Volt(?:age)?(?:\.\s*range)?)\s*[:：=]?\s*(\d+\.?\d*)\s*V/gi,
    ];
    for (const vRe of vPatterns) {
      while ((m = vRe.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        if (val > 0 && val <= 250) { props.push({ key: "rated_voltage", value: val, unit: "V", source }); break; }
      }
      if (props.some((p) => p.key === "rated_voltage")) break;
    }
    if (!props.some((p) => p.key === "rated_voltage")) {
      const vP = scanSpecRow(text, /(?:Rated\s*Volt|額定電壓|额定电压|Operating\s*Volt)/i,
        (v) => v > 0 && v <= 250, "rated_voltage", "V", source);
      if (vP) props.push(vP);
    }
  }

  // ── Current Consumption (buzzers) ──
  if (isBuzzer) {
    const curPatterns = [
      /(?:Current\s*[Cc]onsumption|消耗電流|消耗电流)\s*[:：=]?\s*(?:MAX\.?\s*)?(\d+\.?\d*)\s*(m?)\s*A/gi,
    ];
    for (const curRe of curPatterns) {
      while ((m = curRe.exec(text)) !== null) {
        const val = parseFloat(m[1]) * (m[2] === "m" ? 1 : 1000);
        if (val > 0 && val <= 5000) { props.push({ key: "current_consumption", value: val, unit: "mA", source }); break; }
      }
      if (props.some((p) => p.key === "current_consumption")) break;
    }
    if (!props.some((p) => p.key === "current_consumption")) {
      const curP = scanSpecRow(text, /(?:Current\s*[Cc]onsumption|消耗電流|消耗电流)/i,
        (v) => v > 0 && v <= 5000, "current_consumption", "mA", source);
      if (curP) props.push(curP);
    }
  }

  // ── Microphone Sensitivity (dBV or dB) ──
  if (isMic) {
    const sensPatterns = [
      /(?:Sensitivity|灵敏度|靈敏度)\s*[:：=]?\s*(-\d+\.?\d*)\s*dB\s*(?:V|SPL)?/gi,
      /(-\d{2,3})\s*dB\s*(?:V|SPL|\(0\s*dB\s*=\s*1\s*V\s*\/\s*Pa\))?/gi,
    ];
    for (const sensRe of sensPatterns) {
      while ((m = sensRe.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        if (val >= -80 && val <= -10) { props.push({ key: "sensitivity", value: val, unit: "dBV", source }); break; }
      }
      if (props.some((p) => p.key === "sensitivity")) break;
    }
    if (!props.some((p) => p.key === "sensitivity")) {
      const sensP = scanSpecRow(text, /(?:Sensitivity|灵敏度|靈敏度)/i,
        (v) => v >= -80 && v <= -10, "sensitivity", "dBV", source);
      if (sensP) props.push(sensP);
    }
  }

  // ── Microphone SNR ──
  if (isMic) {
    const snrPatterns = [
      /(?:SNR|Signal[\s-]*to[\s-]*Noise|信噪比)\s*[:：=]?\s*(\d+\.?\d*)\s*dB/gi,
    ];
    for (const snrRe of snrPatterns) {
      while ((m = snrRe.exec(text)) !== null) {
        const val = parseFloat(m[1]);
        if (val >= 30 && val <= 110) { props.push({ key: "snr", value: val, unit: "dB", source }); break; }
      }
      if (props.some((p) => p.key === "snr")) break;
    }
    if (!props.some((p) => p.key === "snr")) {
      const snrP = scanSpecRow(text, /(?:SNR\b|Signal[\s-]*to[\s-]*Noise|信噪比)/i,
        (v) => v >= 30 && v <= 110, "snr", "dB", source);
      if (snrP) props.push(snrP);
    }
  }

  // ── Frequency Range (speakers, mics) ──
  if (isSpeaker || isMic) {
    const frPatterns = [
      /(?:Frequency\s*Rang[eg]|Frequency\s*Response|频率(?:范围|響應|响应)|有效頻寬)\s*[:：=]?\s*(?:Fo\s*[-–—]+\s*)?(\d+\.?\d*)\s*(k|K|M)?\s*H?\s*z?\s*(?:to|~|[-–—])\s*(\d+\.?\d*)\s*(k|K|M)?\s*H?\s*[Zz]/gi,
    ];
    for (const frRe of frPatterns) {
      while ((m = frRe.exec(text)) !== null) {
        const loMult = (m[2] || "").toUpperCase() === "K" ? 1000 : (m[2] || "").toUpperCase() === "M" ? 1e6 : 1;
        const hiMult = (m[4] || "").toUpperCase() === "K" ? 1000 : (m[4] || "").toUpperCase() === "M" ? 1e6 : 1;
        const lo = parseFloat(m[1]) * loMult;
        const hi = parseFloat(m[3]) * hiMult;
        if (hi > lo && hi >= 1000 && hi <= 100000) {
          props.push({ key: "freq_response_max", value: hi, unit: "Hz", source });
          break;
        }
      }
      if (props.some((p) => p.key === "freq_response_max")) break;
    }
  }

  return props;
}

function extractAudioKeywords(text: string): string[] {
  const kw: string[] = [];
  if (/\bactive\s*buzzer\b|有源|Built[\s-]*in\s*Driv/i.test(text)) kw.push("active");
  if (/\bpassive\b|无源|Externally\s*Driven/i.test(text)) kw.push("passive");
  if (/\bpiezoelectric\b|压电|壓電/i.test(text)) kw.push("piezoelectric");
  if (/\belectromagnetic\b|电磁|電磁/i.test(text)) kw.push("electromagnetic");
  if (/\bMEMS\b/i.test(text)) kw.push("mems");
  if (/\belectret\b|驻极体|駐極體/i.test(text)) kw.push("electret");
  if (/\bdigital\s*(?:output|mic)/i.test(text)) kw.push("digital");
  if (/\banalog\s*(?:output|mic)/i.test(text)) kw.push("analog");
  if (/\bomnidirectional\b|全指向/i.test(text)) kw.push("omnidirectional");
  if (/\bunidirectional\b|单指向/i.test(text)) kw.push("unidirectional");
  if (/\bPDM\b/.test(text)) kw.push("pdm");
  if (/\bI2S\b/.test(text)) kw.push("i2s");
  if (/\bwaterproof\b|防水/i.test(text)) kw.push("waterproof");
  if (/\bfull[\s-]*range\b/i.test(text)) kw.push("full-range");
  if (/\bSMD\b|\bSMT\b|surface\s*mount/i.test(text)) kw.push("smd");
  if (/\bthrough[\s-]*hole\b|\bPlugin\b|\bDIP\b/i.test(text)) kw.push("through-hole");
  return [...new Set(kw)];
}

// ── Display extractors (OLED, LCD, LED Segment, E-ink) ──

function extractDisplayProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // ── Resolution — "128x64", "240×128", "320x240" ──
  const resPatterns = [
    /(?:Number\s*of\s*Pixels|Resolution|分辨率|行列点阵数|Pixels?|点阵数)\s*[:：=]?\s*(\d{2,4})\s*[x×X\*]\s*(\d{2,4})/gi,
    /(\d{2,4})\s*[x×X]\s*(\d{2,4})\s*(?:dots?|pixels?|点阵)/gi,
    /(?:Number\s*of\s*Pixels|Pixels?)\s*[:：=]?\s*(\d{2,4})\s{2,}(\d{2,4})/gi,
    // Standalone NNNxNNN — common display resolutions in descriptions (not followed by mm)
    /(?<!\d)(\d{2,4})[x×X](\d{2,4})(?!\s*mm)(?!\.\d)/gi,
  ];
  for (const resRe of resPatterns) {
    while ((m = resRe.exec(text)) !== null) {
      const w = parseInt(m[1]), h = parseInt(m[2]);
      if (w >= 7 && w <= 10000 && h >= 7 && h <= 10000) {
        props.push({ key: "resolution_x", value: w, unit: "px", source });
        props.push({ key: "resolution_y", value: h, unit: "px", source });
        break;
      }
    }
    if (props.some((p) => p.key === "resolution_x")) break;
  }

  // ── Display Size (inches) ──
  const sizePatterns = [
    /(\d+\.?\d*)\s*(?:英寸|inch(?:es)?|"|″)\b/gi,
    /(?:Display\s*Size|Screen\s*Size|对角线)\s*[:：=]?\s*(\d+\.?\d*)/gi,
  ];
  for (const sizeRe of sizePatterns) {
    while ((m = sizeRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 0.2 && val <= 20) { props.push({ key: "display_size", value: val, unit: "inch", source }); break; }
    }
    if (props.some((p) => p.key === "display_size")) break;
  }

  // ── Brightness (OLED, LCD) ──
  const brPatterns = [
    /(?:Brightness|Luminance|亮度)\s*[:：=]?\s*(\d+\.?\d*)\s*(?:cd\/m[²2]|nit)/gi,
    /(\d+\.?\d*)\s*(?:cd\/m[²2]|nit)\b/gi,
  ];
  for (const brRe of brPatterns) {
    while ((m = brRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 10 && val <= 5000) { props.push({ key: "brightness", value: val, unit: "cd/m2", source }); break; }
    }
    if (props.some((p) => p.key === "brightness")) break;
  }
  if (!props.some((p) => p.key === "brightness")) {
    const brP = scanSpecRow(text, /(?:Brightness|Luminance|亮度)/i,
      (v) => v >= 10 && v <= 5000, "brightness", "cd/m2", source);
    if (brP) props.push(brP);
  }

  // ── Supply Voltage ──
  const vsupPatterns = [
    /(?:Supply\s*Voltage|VCC|供电电源|供电电压|工作电压|Operating\s*Voltage)\s*[:：=]?\s*(\d+\.?\d*)\s*(?:to|~|[-–—])\s*(\d+\.?\d*)\s*V/gi,
    /(?:Supply\s*Voltage|VCC|供电电源|供电电压|工作电压)\s*[:：=]?\s*(\d+\.?\d*)\s*V/gi,
  ];
  for (const vsRe of vsupPatterns) {
    while ((m = vsRe.exec(text)) !== null) {
      if (m[2]) {
        const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
        if (hi > lo && hi <= 20) {
          props.push({ key: "vcc_min", value: lo, unit: "V", source });
          props.push({ key: "vcc_max", value: hi, unit: "V", source });
          break;
        }
      } else {
        const val = parseFloat(m[1]);
        if (val > 0 && val <= 20) { props.push({ key: "supply_voltage", value: val, unit: "V", source }); break; }
      }
    }
    if (props.some((p) => p.key === "vcc_min" || p.key === "supply_voltage")) break;
  }

  // ── Contrast Ratio — "2000:1" ──
  const crPatterns = [
    /(?:Contrast\s*(?:Ratio)?|对比度)\s*[:：=]?\s*(\d+)\s*:\s*1/gi,
  ];
  for (const crRe of crPatterns) {
    while ((m = crRe.exec(text)) !== null) {
      const val = parseInt(m[1]);
      if (val >= 10 && val <= 1000000) { props.push({ key: "contrast_ratio", value: val, unit: ":1", source }); break; }
    }
    if (props.some((p) => p.key === "contrast_ratio")) break;
  }

  return props;
}

function extractDisplayKeywords(text: string): string[] {
  const kw: string[] = [];
  if (/\bOLED\b/i.test(text)) kw.push("oled");
  if (/\bAMOLED\b/i.test(text)) kw.push("amoled");
  if (/\bPMOLED\b|Passive\s*(?:Matrix\s*)?OLED/i.test(text)) kw.push("pmoled");
  if (/\bLCD\b/i.test(text)) kw.push("lcd");
  if (/\bTFT\b/i.test(text)) kw.push("tft");
  if (/\bIPS\b/i.test(text)) kw.push("ips");
  if (/\bSTN\b/i.test(text)) kw.push("stn");
  if (/\bFSTN\b/i.test(text)) kw.push("fstn");
  if (/\bE[\s-]*ink\b|\bE[\s-]*paper\b|电子纸/i.test(text)) kw.push("e-ink");
  if (/\bVFD\b|vacuum\s*fluorescent/i.test(text)) kw.push("vfd");
  if (/\b7[\s-]*segment\b|七段/i.test(text)) kw.push("7-segment");
  if (/\bdot[\s-]*matrix\b|点阵/i.test(text)) kw.push("dot-matrix");
  if (/\bI2C\b|\bIIC\b/i.test(text)) kw.push("i2c");
  if (/\bSPI\b/i.test(text)) kw.push("spi");
  if (/\bUART\b/i.test(text)) kw.push("uart");
  if (/\b8080\b|Intel\s*8080/i.test(text)) kw.push("8080-parallel");
  if (/\bRGB\s*(?:interface|IF)\b/i.test(text)) kw.push("rgb-interface");
  if (/\bMIPI\b/i.test(text)) kw.push("mipi");
  if (/\bLVDS\b/i.test(text)) kw.push("lvds");
  const driverICs = [
    /\bSSD130[6-9]\w*/i, /\bSSD131[0-9]\w*/i, /\bSSD132[0-9]\w*/i, /\bSSD135[0-9]\w*/i,
    /\bSH110[6-7]\w*/i,
    /\bST77[0-9]{2}\w*/i, /\bST79[0-9]{2}\w*/i, /\bST756[0-9]\w*/i,
    /\bILI9[0-9]{3}\w*/i,
    /\bHD44780\w*/i, /\bKS0108\w*/i, /\bT6963\w*/i,
    /\bUC170[0-9]\w*/i, /\bHX835[0-9]\w*/i, /\bGC9A0[0-9]\w*/i,
  ];
  for (const icRe of driverICs) {
    const dm = text.match(icRe);
    if (dm) kw.push(dm[0].toUpperCase());
  }
  if (/\bmonochrome\b|单色/i.test(text)) kw.push("monochrome");
  if (/\bWhite\b/i.test(text) && /\bOLED\b|LED\b/i.test(text)) kw.push("white");
  if (/\bfull[\s-]*color\b|彩色/i.test(text)) kw.push("full-color");
  if (/\bLED\s*backlight\b|LED背光/i.test(text)) kw.push("led-backlight");
  if (/\bcommon[\s-]*cathode\b|共阴/i.test(text)) kw.push("common-cathode");
  if (/\bcommon[\s-]*anode\b|共阳/i.test(text)) kw.push("common-anode");
  if (/\btouch[\s-]*screen\b|\btouch[\s-]*panel\b|触摸屏/i.test(text)) kw.push("touchscreen");
  if (/\bcapacitive\s*touch/i.test(text)) kw.push("capacitive-touch");
  if (/\bresistive\s*touch/i.test(text)) kw.push("resistive-touch");
  return [...new Set(kw)];
}

// ── IoT / Communication Module extractors ──

function extractIoTProperties(text: string, source: string): ExtractedProperty[] {
  const props: ExtractedProperty[] = [];
  let m: RegExpExecArray | null;

  // ── TX Power (dBm) ──
  const txPatterns = [
    /(?:TX\s*(?:Output\s*)?Power|Transmit\s*Power|Output\s*Power|发射功率|PA\s*(?:输出)?功率|Maximum\s*(?:Output\s*)?Power)\s*[:：=]?\s*[+]?(\d+\.?\d*)\s*dBm/gi,
    /[+]?(\d+\.?\d*)\s*dBm\s*(?:max|typ|typical)?/gi,
  ];
  for (const txRe of txPatterns) {
    while ((m = txRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 0 && val <= 40) { props.push({ key: "tx_power", value: val, unit: "dBm", source }); break; }
    }
    if (props.some((p) => p.key === "tx_power")) break;
  }
  if (!props.some((p) => p.key === "tx_power")) {
    const txP = scanSpecRow(text, /(?:TX\s*(?:Output\s*)?Power|Transmit\s*Power|Output\s*Power|发射功率)/i,
      (v) => v >= 0 && v <= 40, "tx_power", "dBm", source);
    if (txP) props.push(txP);
  }

  // ── RX Sensitivity (dBm) ──
  const rxPatterns = [
    /(?:(?:RX\s*)?Sensitivity|Receiver\s*Sensitivity|接收灵敏度|接收靈敏度)\s*[:：=]?\s*(-\d+\.?\d*)\s*dBm/gi,
    /(-\d{2,3})\s*dBm\s*(?:sensitivity)?/gi,
  ];
  for (const rxRe of rxPatterns) {
    while ((m = rxRe.exec(text)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= -160 && val <= -30) { props.push({ key: "rx_sensitivity", value: val, unit: "dBm", source }); break; }
    }
    if (props.some((p) => p.key === "rx_sensitivity")) break;
  }
  if (!props.some((p) => p.key === "rx_sensitivity")) {
    const rxP = scanSpecRow(text, /(?:Sensitivity|接收灵敏度|接收靈敏度)/i,
      (v) => v >= -160 && v <= -30, "rx_sensitivity", "dBm", source);
    if (rxP) props.push(rxP);
  }

  // ── Operating Frequency Band ──
  const bandPatterns = [
    /(?:频谱范围|频率范围|Frequency\s*(?:Range|Band)|工作频段|Operating\s*Freq(?:uency)?)\s*[:：=]?\s*(\d+\.?\d*)\s*(?:to|~|[-–—])\s*(\d+\.?\d*)\s*(M|G)?\s*H\s*z/gi,
    /(\d+\.?\d*)\s*(M|G)\s*H\s*z\s*(?:band|ISM|频段)?/gi,
  ];
  for (const bandRe of bandPatterns) {
    while ((m = bandRe.exec(text)) !== null) {
      if (m[2] && m[3]) {
        const loMult = (m[3] || "M").toUpperCase() === "G" ? 1e3 : 1;
        const center = (parseFloat(m[1]) + parseFloat(m[2])) / 2 * loMult;
        if (center >= 100 && center <= 10000) { props.push({ key: "freq_band", value: center, unit: "MHz", source }); break; }
      } else {
        const mult = (m[2] || "M").toUpperCase() === "G" ? 1000 : 1;
        const val = parseFloat(m[1]) * mult;
        if (val >= 100 && val <= 10000) { props.push({ key: "freq_band", value: val, unit: "MHz", source }); break; }
      }
    }
    if (props.some((p) => p.key === "freq_band")) break;
  }

  // ── Supply Voltage ──
  const vsupPatterns = [
    /(?:Supply\s*Voltage|VCC|VDD|Operating\s*Voltage|工作电压|供电电压|供电范围)\s*[:：=]?\s*(\d+\.?\d*)\s*(?:to|~|[-–—])\s*(\d+\.?\d*)\s*V/gi,
    /(?:Supply\s*Voltage|VCC|VDD|Operating\s*Voltage|工作电压)\s*[:：=]?\s*(\d+\.?\d*)\s*V/gi,
  ];
  for (const vsRe of vsupPatterns) {
    while ((m = vsRe.exec(text)) !== null) {
      if (m[2]) {
        const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
        if (hi > lo && hi <= 7) {
          props.push({ key: "vcc_min", value: lo, unit: "V", source });
          props.push({ key: "vcc_max", value: hi, unit: "V", source });
          break;
        }
      } else {
        const val = parseFloat(m[1]);
        if (val >= 1 && val <= 7) { props.push({ key: "supply_voltage", value: val, unit: "V", source }); break; }
      }
    }
    if (props.some((p) => p.key === "vcc_min" || p.key === "supply_voltage")) break;
  }

  return props;
}

function extractIoTKeywords(text: string): string[] {
  const kw: string[] = [];
  if (/\bWi[\s-]*Fi\b|\b802\.11\b|WLAN/i.test(text)) kw.push("wifi");
  if (/\b802\.11\s*ax\b|\bWi[\s-]*Fi\s*6\b/i.test(text)) kw.push("wifi6");
  if (/\bBluetooth\b|\bBLE\b/i.test(text)) kw.push("bluetooth");
  if (/\bBLE\s*5\.[0-3]\b|Bluetooth\s*5\.[0-3]/i.test(text)) kw.push("ble5");
  if (/\bBLE\s*4\.[0-2]\b|Bluetooth\s*4\.[0-2]/i.test(text)) kw.push("ble4");
  if (/\bLoRa(?:WAN)?\b/i.test(text)) kw.push("lora");
  if (/\bZigbee\b/i.test(text)) kw.push("zigbee");
  if (/\bThread\b/i.test(text)) kw.push("thread");
  if (/\bMatter\b/i.test(text)) kw.push("matter");
  if (/\bNB[\s-]*IoT\b/i.test(text)) kw.push("nb-iot");
  if (/\bLTE[\s-]*Cat[\s-]*M/i.test(text)) kw.push("lte-cat-m");
  if (/\b(?:2G|GSM|GPRS)\b/i.test(text)) kw.push("gsm");
  if (/\b(?:4G|LTE)\b/i.test(text)) kw.push("lte");
  if (/\b5G[\s-]*NR\b|\b5G\b/i.test(text)) kw.push("5g");
  if (/\bGNSS\b|\bGPS\b|\bBeiDou\b|\bGLONASS\b|\bGalileo\b/i.test(text)) kw.push("gnss");
  if (/\bRFID\b/i.test(text)) kw.push("rfid");
  if (/\bNFC\b/i.test(text)) kw.push("nfc");
  if (/\bSigFox\b/i.test(text)) kw.push("sigfox");
  if (/\bSub[\s-]*GHz\b|\bsub[\s-]*1\s*GHz/i.test(text)) kw.push("sub-ghz");
  if (/\b433\s*M\s*H\s*z/i.test(text)) kw.push("433mhz");
  if (/\b868\s*M\s*H\s*z/i.test(text)) kw.push("868mhz");
  if (/\b915\s*M\s*H\s*z/i.test(text)) kw.push("915mhz");
  if (/\b2\.4\s*G\s*H\s*z/i.test(text)) kw.push("2.4ghz");
  if (/\b5\s*G\s*H\s*z\b.*\bband\b|\b5\s*G\s*H\s*z\b.*\bWi[\s-]*Fi/i.test(text)) kw.push("5ghz");
  const chipPatterns: [RegExp, string][] = [
    [/\bESP8266\b/i, "ESP8266"], [/\bESP32\b/i, "ESP32"], [/\bESP32-S3\b/i, "ESP32-S3"],
    [/\bESP32-C3\b/i, "ESP32-C3"], [/\bESP32-S2\b/i, "ESP32-S2"], [/\bESP32-C6\b/i, "ESP32-C6"],
    [/\bBL602\b/i, "BL602"], [/\bBL616\b/i, "BL616"], [/\bBL618\b/i, "BL618"],
    [/\bnRF52832\b/i, "nRF52832"], [/\bnRF52840\b/i, "nRF52840"], [/\bnRF52810\b/i, "nRF52810"],
    [/\bCC2530\b/i, "CC2530"], [/\bCC2640\b/i, "CC2640"], [/\bCC1101\b/i, "CC1101"],
    [/\bSX1276\b/i, "SX1276"], [/\bSX1278\b/i, "SX1278"], [/\bSX1262\b/i, "SX1262"],
    [/\bRTL8720\b/i, "RTL8720"], [/\bMT7688\b/i, "MT7688"],
  ];
  for (const [re, name] of chipPatterns) {
    if (re.test(text)) kw.push(name.toLowerCase());
  }
  if (/\bIPEX\b|\bu\.FL\b|\bU\.FL\b/i.test(text)) kw.push("ipex");
  if (/\bPCB\s*[Aa]ntenna\b|On[\s-]*board\s*PCB\s*Antenna|板载天线/i.test(text)) kw.push("pcb-antenna");
  if (/\bchip\s*antenna\b/i.test(text)) kw.push("chip-antenna");
  if (/\bexternal\s*antenna\b|外置天线/i.test(text)) kw.push("external-antenna");
  if (/\bUART\b/i.test(text)) kw.push("uart");
  if (/\bSPI\b/i.test(text)) kw.push("spi");
  if (/\bI2C\b|\bIIC\b/i.test(text)) kw.push("i2c");
  if (/\bUSB\b/i.test(text)) kw.push("usb");
  if (/\bSDIO\b/i.test(text)) kw.push("sdio");
  if (/\bAT\s*command/i.test(text)) kw.push("at-command");
  if (/\bFSK\b/.test(text)) kw.push("fsk");
  if (/\bGFSK\b/.test(text)) kw.push("gfsk");
  if (/\bOOK\b/.test(text)) kw.push("ook");
  return [...new Set(kw)];
}


function dedup(props: ExtractedProperty[]): ExtractedProperty[] {
  const seen = new Set<string>();
  return props.filter((p) => { const k = `${p.key}:${p.value}:${p.unit}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function extractComponentProperties(
  text: string, category: string, subcategory: string, source: string,
): ExtractionResult {
  const result: ExtractionResult = { properties: [], keywords: [] };
  if (!text || text.length < 10) return result;
  const kwText = source === "datasheet" ? text.substring(0, Math.floor(text.length * 0.4)) : text;
  result.properties.push(...extractGenericNumericValues(text, source, category));
  result.keywords.push(...extractComplianceKeywords(kwText));
  result.keywords.push(...extractTemperatureRange(text));
  result.keywords.push(...extractFeatureKeywords(kwText));
  const cat = category.toLowerCase();
  const sub = subcategory.toLowerCase();
  const combined = `${cat} ${sub}`;
  if (combined.includes("resistor") || sub.includes("potentiometer")) result.properties.push(...extractResistorProperties(text, source));
  if (combined.includes("capacitor")) { result.properties.push(...extractCapacitorProperties(text, source)); result.keywords.push(...extractCapacitorKeywords(kwText)); }
  if (combined.includes("inductor") || combined.includes("coil") || combined.includes("choke") || combined.includes("transformer")) result.properties.push(...extractInductorProperties(text, source));
  if (combined.includes("diode") || sub.includes("rectifier") || sub.includes("bridge")) result.properties.push(...extractDiodeProperties(text, source));
  if (combined.includes("transistor") || combined.includes("mosfet") || combined.includes("thyristor") ||
      cat.includes("triode") || cat.includes("mos tube") ||
      cat.includes("silicon carbide") || cat.includes("gallium nitride") ||
      sub.includes("igbt") || sub.includes("jfet") || sub.includes("triac") || sub.includes("darlington"))
    result.properties.push(...extractTransistorProperties(text, source));
  if (combined.includes("processor") || combined.includes("controller") || combined.includes("driver") ||
      combined.includes("interface") || combined.includes("logic") || combined.includes("memory") ||
      combined.includes("power management") || combined.includes("pmic") ||
      cat.includes("amplifier") || cat.includes("comparator") || cat.includes("operational amplifier") ||
      cat.includes("data acquisition") || cat.includes("data converter") || cat.includes("adc/dac") ||
      cat.includes("communication interface") || cat.includes("single chip") || cat.includes("microcontroller") ||
      cat.includes("clock") || cat.includes("timing") || cat.includes("rtc") ||
      cat.includes("signal isolation") || cat.includes("isolator") || cat.includes("optoisolator") ||
      cat.includes("embedded peripheral") || cat.includes("analog ic") ||
      cat.includes("power supply chip") || cat.includes("led driver") || cat.includes("motor driver") ||
      cat.includes("magnetic sensor") || cat.includes("display module"))
    result.properties.push(...extractICProperties(text, source));
  if (combined.includes("connector") || combined.includes("header") || combined.includes("socket") ||
      combined.includes("plug") || combined.includes("jack") || combined.includes("terminal") ||
      combined.includes("ffc") || combined.includes("fpc") || combined.includes("housing") ||
      cat.includes("wire") || cat.includes("cable") || cat.includes("electromechanical")) {
    result.properties.push(...extractConnectorProperties(text, source));
    result.keywords.push(...extractConnectorKeywords(kwText));
  }
  if (combined.includes("circuit protection") || combined.includes("tvs") || combined.includes("esd") ||
      combined.includes("fuse") || combined.includes("varistor") || combined.includes("surge") ||
      combined.includes("gdt") || combined.includes("gas discharge")) {
    const cpResult = extractCircuitProtectionProperties(text, source);
    result.properties.push(...cpResult.properties);
    result.keywords.push(...cpResult.keywords);
    result.keywords.push(...extractCircuitProtectionKeywords(kwText));
  }
  if (combined.includes("crystal") || combined.includes("oscillator") || combined.includes("resonator")) {
    result.properties.push(...extractCrystalProperties(text, source));
    result.keywords.push(...extractCrystalKeywords(kwText));
  }
  if (combined.includes("optoelectronic") || combined.includes("led") || combined.includes("photodiode") ||
      combined.includes("optocoupler") || combined.includes("phototransistor") || combined.includes("infrared") ||
      combined.includes("ultraviolet") || combined.includes("uvled") || combined.includes("laser") ||
      combined.includes("rgb") || combined.includes("cob") || combined.includes("photomos") ||
      combined.includes("solid state relay") || combined.includes("photointerrupter") ||
      combined.includes("irda") || combined.includes("fiber optical")) {
    result.properties.push(...extractOptoProperties(text, source));
    result.keywords.push(...extractOptoKeywords(kwText));
  }
  if (combined.includes("memory") || combined.includes("eeprom") || combined.includes("flash") ||
      combined.includes("sram") || combined.includes("dram") || combined.includes("sdram") ||
      combined.includes("fram") || combined.includes("fifo")) {
    result.properties.push(...extractMemoryProperties(text, source));
    result.keywords.push(...extractMemoryKeywords(kwText));
  }
  if (combined.includes("logic") || combined.includes("gate") || combined.includes("flip flop") ||
      combined.includes("latch") || combined.includes("buffer") || combined.includes("inverter") ||
      combined.includes("counter") || combined.includes("shift register") || combined.includes("decoder") ||
      combined.includes("multiplexer") || combined.includes("translator") || combined.includes("level shifter") ||
      combined.includes("monostable") || combined.includes("comparator") || combined.includes("parity")) {
    result.properties.push(...extractLogicProperties(text, source));
    result.keywords.push(...extractLogicKeywords(kwText));
  }
  if (combined.includes("sensor") || combined.includes("thermistor") || combined.includes("accelerometer") ||
      combined.includes("hall") || combined.includes("pressure") || combined.includes("humidity") ||
      combined.includes("gyro") || combined.includes("light sensor") || combined.includes("photoresistor") ||
      combined.includes("current sensor") || combined.includes("position") || combined.includes("magnetic") ||
      combined.includes("proximity") || combined.includes("touch")) {
    result.properties.push(...extractSensorProperties(text, source));
    result.keywords.push(...extractSensorKeywords(kwText));
  }
  if (combined.includes("power module") || combined.includes("dc-dc") || combined.includes("ac-dc") ||
      combined.includes("dc-ac") || combined.includes("ldo") || combined.includes("linear voltage regulator") ||
      combined.includes("power management") || combined.includes("pmic") ||
      combined.includes("converter") || combined.includes("charge pump") ||
      combined.includes("isolated") || combined.includes("switching")) {
    result.properties.push(...extractPowerProperties(text, source));
    result.keywords.push(...extractPowerKeywords(kwText));
  }
  if (combined.includes("switch")) {
    result.properties.push(...extractSwitchProperties(text, source));
    result.keywords.push(...extractSwitchKeywords(kwText));
  }
  if (combined.includes("filter") || combined.includes("ferrite bead") || combined.includes("common mode") ||
      combined.includes("emi") || combined.includes("emc") || combined.includes("saw") ||
      combined.includes("noise suppress") || combined.includes("feed through") ||
      combined.includes("clamp")) {
    result.properties.push(...extractFilterProperties(text, source));
    result.keywords.push(...extractFilterKeywords(kwText));
  }
  if (combined.includes("rf") || combined.includes("wireless") || combined.includes("radio") ||
      combined.includes("antenna") || combined.includes("balun") || combined.includes("transceiver") ||
      combined.includes("amplifier") || combined.includes("lna") || combined.includes("mixer") ||
      combined.includes("attenuator") || combined.includes("duplexer") || combined.includes("coupler") ||
      combined.includes("splitter") || combined.includes("combiner") || combined.includes("detector")) {
    result.properties.push(...extractRFProperties(text, source));
    result.keywords.push(...extractRFKeywords(kwText));
  }
  if (combined.includes("relay")) {
    result.properties.push(...extractRelayProperties(text, source));
    result.keywords.push(...extractRelayKeywords(kwText));
  }
  if (combined.includes("audio") || combined.includes("buzzer") || combined.includes("speaker") ||
      combined.includes("microphone") || combined.includes("vibration motor")) {
    result.properties.push(...extractAudioProperties(text, source));
    result.keywords.push(...extractAudioKeywords(kwText));
  }
  if (combined.includes("display") || combined.includes("oled") || combined.includes("lcd") ||
      combined.includes("led segment") || combined.includes("dot matrix") || combined.includes("e-ink") ||
      combined.includes("fluorescent")) {
    result.properties.push(...extractDisplayProperties(text, source));
    result.keywords.push(...extractDisplayKeywords(kwText));
  }
  if (combined.includes("iot") || combined.includes("communication") || combined.includes("wifi") ||
      combined.includes("bluetooth") || combined.includes("lora") || combined.includes("zigbee") ||
      combined.includes("rf module") || combined.includes("gnss") || combined.includes("2g") ||
      combined.includes("3g") || combined.includes("4g") || combined.includes("5g") ||
      combined.includes("nb-iot") || combined.includes("ethernet module") ||
      combined.includes("rfid") || combined.includes("nfc")) {
    result.properties.push(...extractIoTProperties(text, source));
    result.keywords.push(...extractIoTKeywords(kwText));
  }
  result.properties = dedup(result.properties);
  result.keywords = [...new Set(result.keywords.map((k) => k.toLowerCase()))];
  return result;
}
