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
  // ESR — inline with proper Ω|Ohm matching
  const esrRe = /ESR\s*[:=<≤]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*(?:Ω|Ohm|ohm)/gi;
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
  const dcrRe = /(?:DCR|RDC|R\s*DC|DC\s*Resistance)\s*[:=<≤]?\s*(\d+(?:\.\d+)?)\s*(m?)\s*(?:Ω|Ohm|ohm)/gi;
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
  const rdsRe = /R[Dd][Ss]\s*\(\s*[Oo][Nn]\s*\)\s*[:=]?\s*(\d+\.?\d*)\s*(m?)\s*(?:Ω|Ohm|ohm)/g;
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

// ── Deduplication & Main ──

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
  const combined = `${category.toLowerCase()} ${subcategory.toLowerCase()}`;
  if (combined.includes("resistor")) result.properties.push(...extractResistorProperties(text, source));
  if (combined.includes("capacitor")) { result.properties.push(...extractCapacitorProperties(text, source)); result.keywords.push(...extractCapacitorKeywords(kwText)); }
  if (combined.includes("inductor") || combined.includes("coil") || combined.includes("choke")) result.properties.push(...extractInductorProperties(text, source));
  if (combined.includes("diode")) result.properties.push(...extractDiodeProperties(text, source));
  if (combined.includes("transistor") || combined.includes("mosfet") || combined.includes("thyristor")) result.properties.push(...extractTransistorProperties(text, source));
  if (combined.includes("processor") || combined.includes("controller") || combined.includes("driver") ||
      combined.includes("interface") || combined.includes("logic") || combined.includes("memory") ||
      combined.includes("power management") || combined.includes("pmic")) result.properties.push(...extractICProperties(text, source));
  result.properties = dedup(result.properties);
  result.keywords = [...new Set(result.keywords.map((k) => k.toLowerCase()))];
  return result;
}
