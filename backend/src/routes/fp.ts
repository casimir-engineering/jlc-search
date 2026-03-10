import { Hono } from "hono";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";

export const fpRouter = new Hono();

const IMG_DIR = process.env.IMG_CACHE_DIR
  ?? join(import.meta.dir, "../../../data/img");

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

function svgCachePath(lcsc: string): string {
  return join(IMG_DIR, `${lcsc}.svg`);
}

function noFpPath(lcsc: string): string {
  return join(IMG_DIR, `${lcsc}.nofp`);
}

function isOnCooldown(lcsc: string): boolean {
  const p = noFpPath(lcsc);
  if (!existsSync(p)) return false;
  try {
    const ts = parseInt(readFileSync(p, "utf8"));
    if (Date.now() - ts < RETRY_AFTER_MS) return true;
    unlinkSync(p);
  } catch { /* ignore */ }
  return false;
}

function markNoFp(lcsc: string): void {
  try {
    mkdirSync(IMG_DIR, { recursive: true });
    writeFileSync(noFpPath(lcsc), Date.now().toString());
  } catch { /* ignore */ }
}

// PCB layer render styles (for white background display)
// fmt: { stroke, fill, strokeWidth?, strokeDasharray? }
const LAYER_STYLES: Record<number, { stroke: string; fill: string; strokeWidth?: number; strokeDasharray?: string }> = {
  1:   { stroke: "none",    fill: "#c83737" },                                              // top copper (red)
  2:   { stroke: "none",    fill: "#6464c8" },                                              // bottom copper (blue)
  3:   { stroke: "#555555", fill: "none" },                                                 // top silkscreen (dark gray)
  4:   { stroke: "#338833", fill: "none" },                                                 // bottom silkscreen (green)
  11:  { stroke: "none",    fill: "#c87137" },                                              // multi-layer SMD/THT pads (copper)
  12:  { stroke: "#cc00cc", fill: "none",    strokeWidth: 0.15, strokeDasharray: "2 2" },  // top courtyard (magenta)
  13:  { stroke: "#0077cc", fill: "none",    strokeWidth: 0.15, strokeDasharray: "2 2" },  // bottom courtyard (blue)
  99:  { stroke: "#aaaaaa", fill: "#e8e8e8" },                                              // component body (light gray)
  100: { stroke: "none",    fill: "#5f8c5a" },                                              // multi-layer / exposed pad (green)
  101: { stroke: "#cccccc", fill: "none",    strokeWidth: 0.1 },                           // component boundary
};

// Copper SOLIDREGIONs render behind body; PADs/TRACKs render on top
const COPPER_LAYERS = new Set([1, 2, 11, 100]);
// Render order for non-fill shapes (PADs, TRACKs, etc.) — body first, then pads on top
const RENDER_ORDER = [99, 11, 101, 12, 13, 4, 3, 2, 1];

// ── Map-style scale bar algorithm ──────────────────────────────────────────

const MM_PER_MIL = 0.0254;

/** Nice round numbers for metric scale divisions */
const METRIC_STEPS = [0.125, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];

interface ScaleTick {
  /** Position in mm from bar start (0 = left edge) */
  positionMM: number;
  /** Label text (e.g. "5mm" or "100mil") */
  label: string;
  /** "major" ticks get full-height marks; "minor" get half-height */
  type: "major" | "minor";
  /** Which unit system */
  system: "metric" | "imperial";
}

interface ScaleBarSpec {
  /** Total bar length in mm */
  barLengthMM: number;
  /** Metric step size in mm (each alternating segment) */
  segmentMM: number;
  /** Number of alternating segments */
  segmentCount: number;
  /** All tick marks with positions and labels */
  ticks: ScaleTick[];
}

/**
 * Compute a map-style scale bar for a given footprint width.
 *
 * The bar uses alternating black/white segments at nice metric intervals,
 * with both metric (mm) and imperial (mil) tick labels at round values.
 *
 * Target bar length: 30-50% of footprint width.
 */
function computeScaleBar(footprintWidthMM: number): ScaleBarSpec {
  // Target: bar should be 30-60% of footprint width
  const targetMin = footprintWidthMM * 0.25;
  const targetMax = footprintWidthMM * 0.65;
  const targetIdeal = footprintWidthMM * 0.40;

  // Pick the single discrete METRIC_STEPS value closest to ideal within range
  let bestMM = METRIC_STEPS[0];
  let bestDist = Infinity;
  for (const step of METRIC_STEPS) {
    if (step < targetMin * 0.7 || step > targetMax * 1.3) continue;
    const dist = Math.abs(step - targetIdeal);
    if (dist < bestDist) {
      bestDist = dist;
      bestMM = step;
    }
  }
  // Fallback: if nothing fit, pick the largest step that's <= footprint width
  if (bestDist === Infinity) {
    for (const step of METRIC_STEPS) {
      if (step <= footprintWidthMM * 0.8) bestMM = step;
    }
  }

  // Bar length IS the step value — no multiplication
  // segmentCount controls the alternating pattern (purely visual)
  // Pick 2, 4, or 5 visual segments for the alternating pattern
  let segCount = 4;
  if (bestMM <= 0.25) segCount = 2;
  else if (bestMM >= 25) segCount = 5;

  return {
    barLengthMM: bestMM,
    segmentMM: bestMM / segCount,
    segmentCount: segCount,
    ticks: [],
  };
}

/** Format a mm value as a clean label: "0", "0.5mm", "1mm", "10mm" etc. */
function formatMetric(mm: number): string {
  if (mm === 0) return "0";
  const rounded = Math.round(mm * 1000) / 1000;
  if (rounded === Math.floor(rounded)) return `${Math.floor(rounded)}mm`;
  return `${rounded}mm`;
}

function arrayMin(arr: number[]): number {
  let min = Infinity;
  for (const v of arr) if (v < min) min = v;
  return min;
}
function arrayMax(arr: number[]): number {
  let max = -Infinity;
  for (const v of arr) if (v > max) max = v;
  return max;
}

function renderFootprintSvg(data: Record<string, unknown>, pkgName?: string): string | null {
  const shapes = (data.shape as string[]) ?? [];
  const head = data.head as Record<string, unknown> | undefined;
  const pkgTitle = pkgName || (head?.c_para as Record<string, string>)?.package || "";

  // If layer-11 pads exist (connector/THT parts), layer-100 SOLIDREGIONs are internal
  // lead-path geometry (elongated stems between pad rows) — skip them to match JLC view.
  const hasLayer11Pads = shapes.some(s => {
    const f = s.split("~");
    return f[0] === "PAD" && f[6] === "11";
  });

  const allX: number[] = [];
  const allY: number[] = [];

  // First pass: collect coordinates for bounding box
  for (const shape of shapes) {
    const f = shape.split("~");
    const type = f[0];

    if (type === "PAD") {
      // PAD~shape~cx~cy~w~h~layer~~pin~angle~hole~points~...
      const pts = f[10]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
      if (pts.length >= 4) {
        for (let i = 0; i + 1 < pts.length; i += 2) { allX.push(pts[i]); allY.push(pts[i + 1]); }
      } else {
        const cx = parseFloat(f[2]), cy = parseFloat(f[3]);
        const w = parseFloat(f[4]), h = parseFloat(f[5]);
        if (!isNaN(cx)) { allX.push(cx - w / 2, cx + w / 2); allY.push(cy - h / 2, cy + h / 2); }
      }
    } else if (type === "TRACK") {
      const pts = f[4]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
      for (let i = 0; i + 1 < pts.length; i += 2) {
        if (!isNaN(pts[i])) { allX.push(pts[i]); allY.push(pts[i + 1]); }
      }
    } else if (type === "ARC") {
      // ARC~w~layer~net~svgpath~~gge_id~lock — extract start (M) and end coords
      const nums = f[4]?.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
      // M x1 y1 A rx ry rot large-arc sweep x2 y2 → 9 numbers
      if (nums.length >= 2) { allX.push(nums[0]); allY.push(nums[1]); }
      if (nums.length >= 9) { allX.push(nums[7]); allY.push(nums[8]); }
    } else if (type === "CIRCLE") {
      const cx = parseFloat(f[1]), cy = parseFloat(f[2]), r = parseFloat(f[3]);
      if (!isNaN(cx)) { allX.push(cx - r, cx + r); allY.push(cy - r, cy + r); }
    }
  }

  if (allX.length === 0) return null;

  const UNIT_TO_MM = 0.254;

  const minX = arrayMin(allX), maxX = arrayMax(allX);
  const minY = arrayMin(allY), maxY = arrayMax(allY);
  const bw = maxX - minX || 10, bh = maxY - minY || 10;
  const maxDim = Math.max(bw, bh);
  const padding = maxDim * 0.12 + 1;

  // Extra bottom space for scale bar + SOT-23-6 reference
  const scaleBarExtra = maxDim * 0.35 + 3;
  const bottomPadding = padding + scaleBarExtra;

  const vx = minX - padding, vy = minY - padding;
  const sotRefWidth = (11.42 + 2.09 * 2) + padding * 0.8; // SOT-23-6 total width + gap
  const vw = bw + 2 * padding + sotRefWidth, vh = bh + padding + bottomPadding;

  // Second pass: build SVG elements grouped by layer
  const byLayer: Record<number, string[]> = {};
  for (const l of RENDER_ORDER) byLayer[l] = [];
  // Copper SOLIDREGIONs render behind the body so they don't cover it
  const copperFills: string[] = [];

  // Collect pad info for pin labels
  const padLabels: { cx: number; cy: number; pin: string; w: number; h: number }[] = [];

  for (const shape of shapes) {
    const f = shape.split("~");
    const type = f[0];

    if (type === "PAD") {
      const layer = parseInt(f[6]);
      const s = LAYER_STYLES[layer];
      if (!s) continue;
      if (!byLayer[layer]) byLayer[layer] = [];

      const padShape = f[1];
      const cx = parseFloat(f[2]), cy = parseFloat(f[3]);
      const w = parseFloat(f[4]), h = parseFloat(f[5]);
      const angle = parseFloat(f[9]) || 0;
      if (isNaN(cx)) continue;

      const pin = f[8]?.trim();
      if (pin && (layer === 1 || layer === 11)) {
        padLabels.push({ cx, cy, pin, w, h });
      }

      if (padShape === "OVAL") {
        // Stadium shape: rounded rect with radius = min(w,h)/2
        const rx = Math.min(w, h) / 2;
        const rot = angle !== 0 ? ` transform="rotate(${angle},${cx},${cy})"` : "";
        byLayer[layer].push(
          `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${s.fill}" stroke="none"${rot}/>`
        );
      } else if (padShape === "ELLIPSE") {
        byLayer[layer].push(
          `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${s.fill}" stroke="none"/>`
        );
      } else {
        // RECT, POLYGON — use pre-rotated corner points when available
        const pts = f[10]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
        if (pts.length >= 8) {
          const points: string[] = [];
          for (let i = 0; i + 1 < pts.length; i += 2) points.push(`${pts[i]},${pts[i + 1]}`);
          byLayer[layer].push(`<polygon points="${points.join(" ")}" fill="${s.fill}" stroke="none"/>`);
        } else {
          const rot = angle !== 0 ? ` transform="rotate(${angle},${cx},${cy})"` : "";
          byLayer[layer].push(
            `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" fill="${s.fill}" stroke="none"${rot}/>`
          );
        }
      }
    } else if (type === "TRACK") {
      const layer = parseInt(f[2]);
      const s = LAYER_STYLES[layer];
      if (!s) continue;
      if (!byLayer[layer]) byLayer[layer] = [];

      const sw = parseFloat(f[1]) || 0.5;
      const pts = f[4]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
      if (pts.length < 4) continue;
      const points: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) points.push(`${pts[i]},${pts[i + 1]}`);
      const dash = s.strokeDasharray ? ` stroke-dasharray="${s.strokeDasharray}"` : "";
      byLayer[layer].push(
        `<polyline points="${points.join(" ")}" stroke="${s.stroke}" fill="none" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`
      );
    } else if (type === "ARC") {
      // ARC~w~layer~net~svgpath~~gge_id~lock
      const layer = parseInt(f[2]);
      const s = LAYER_STYLES[layer];
      if (!s) continue;
      if (!byLayer[layer]) byLayer[layer] = [];

      const sw = parseFloat(f[1]) || 0.5;
      const path = f[4]?.trim();
      if (!path?.startsWith("M")) continue;
      const dash = s.strokeDasharray ? ` stroke-dasharray="${s.strokeDasharray}"` : "";
      byLayer[layer].push(
        `<path d="${path}" stroke="${s.stroke}" fill="none" stroke-width="${sw}" stroke-linecap="round"${dash}/>`
      );
    } else if (type === "CIRCLE") {
      const layer = parseInt(f[5]);
      const s = LAYER_STYLES[layer];
      if (!s) continue;
      if (!byLayer[layer]) byLayer[layer] = [];

      const cx = parseFloat(f[1]), cy = parseFloat(f[2]);
      const r = parseFloat(f[3]), sw = parseFloat(f[4]) || 0.2;
      if (isNaN(cx) || r <= 0) continue;
      // Courtyard CIRCLEs are pin-1 markers — render as filled white dot, not a dashed ring
      if (layer === 12 || layer === 13) {
        byLayer[layer].push(
          `<circle cx="${cx}" cy="${cy}" r="${r}" fill="white" stroke="${s.stroke}" stroke-width="0.2"/>`
        );
      } else {
        const dash = s.strokeDasharray ? ` stroke-dasharray="${s.strokeDasharray}"` : "";
        byLayer[layer].push(
          `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${s.stroke}" fill="${s.fill ?? "none"}" stroke-width="${sw}"${dash}/>`
        );
      }
    } else if (type === "SOLIDREGION") {
      const layer = parseInt(f[1]);
      // Skip layer-100 fills when layer-11 pads handle the visual (connector lead geometry)
      if (layer === 100 && hasLayer11Pads) continue;
      const s = LAYER_STYLES[layer];
      if (!s) continue;

      const path = f[3];
      if (!path?.includes("M")) continue;
      const el = `<path d="${path}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="0.3"/>`;

      // Copper fills render behind the body so component body stays visible
      if (COPPER_LAYERS.has(layer)) {
        copperFills.push(el);
      } else {
        if (!byLayer[layer]) byLayer[layer] = [];
        byLayer[layer].push(el);
      }
    }
    // SVGNODE (layer 19, 3D outline helper) and other types are intentionally skipped
  }

  // Copper fills first (behind body), then body + pads + silkscreen on top
  const elements = [...copperFills, ...RENDER_ORDER.flatMap(l => byLayer[l] ?? [])];
  if (elements.length === 0) return null;

  // Render pin labels on top of pads
  const labels: string[] = [];
  const minFontSize = Math.max(bw, bh) * 0.072;
  for (const { cx, cy, pin, w, h } of padLabels) {
    // For the text to fit inside the pad, constrain by both dimensions.
    // Text aspect ratio ~0.6:1 (width:height per character), so fitW allows more height.
    const textWidth = pin.length * 0.6; // approximate character count in em-widths
    const fitByW = w * 0.765 / textWidth;
    const fitByH = h * 0.63;
    const fontSize = Math.max(Math.min(fitByW, fitByH), minFontSize);
    labels.push(
      `<text x="${cx}" y="${cy}" font-size="${fontSize.toFixed(2)}" fill="white" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-weight="bold">${pin}</text>`
    );
  }

  // --- Dual-bar map-style scale (metric on top, imperial below, touching) ---
  const scaleEls: string[] = [];
  const footprintWidthMM = bw * UNIT_TO_MM;
  const spec = computeScaleBar(footprintWidthMM);

  const barUnits = spec.barLengthMM / UNIT_TO_MM;
  const segUnits = spec.segmentMM / UNIT_TO_MM;

  // Compute imperial bar — pick the largest discrete mil value that fits within the metric bar
  const barLengthMil = spec.barLengthMM / MM_PER_MIL;
  const NICE_MIL = [1, 5, 25, 50, 100, 250, 500, 1000];
  let imperialMil = NICE_MIL[0];
  for (const m of NICE_MIL) {
    if (m <= barLengthMil * 0.95) imperialMil = m;
  }
  const imperialBarUnits = (imperialMil * MM_PER_MIL) / UNIT_TO_MM;

  // Imperial bar visual segmentation (purely cosmetic alternating pattern)
  let impSegCount = 2;
  if (imperialMil >= 250) impSegCount = 5;
  else if (imperialMil >= 50) impSegCount = 4;
  else if (imperialMil >= 5) impSegCount = 2;
  else impSegCount = 1;
  const impSegUnits = imperialBarUnits / impSegCount;

  const scaleSW = Math.max(maxDim * 0.003, 0.15);
  const barH = Math.max(maxDim * 0.014, scaleSW * 3);
  const tickExt = Math.max(maxDim * 0.015, barH * 0.5);
  const scaleFontSize = Math.max(maxDim * 0.055, 1.0);

  const scaleCX = minX + bw / 2;
  const barX0 = scaleCX - barUnits / 2;

  // Vertical layout
  const scaleTopY = maxY + padding * 0.6;
  const metricLabelY = scaleTopY;
  const metricBarY = scaleTopY + scaleFontSize * 0.5;
  const imperialBarY = metricBarY + barH;           // touching
  const imperialLabelY = imperialBarY + barH + tickExt + scaleFontSize * 0.9;
  const pkgLabelY = imperialLabelY + scaleFontSize * 2.5;

  // Metric bar — alternating dark/white segments
  for (let i = 0; i < spec.segmentCount; i++) {
    const x = barX0 + i * segUnits;
    const fill = i % 2 === 0 ? "#444" : "#fff";
    scaleEls.push(
      `<rect x="${x}" y="${metricBarY}" width="${segUnits}" height="${barH}" fill="${fill}" stroke="#444" stroke-width="${scaleSW * 0.7}"/>`
    );
  }

  // Imperial bar — alternating blue/white segments
  for (let i = 0; i < impSegCount; i++) {
    const x = barX0 + i * impSegUnits;
    const fill = i % 2 === 0 ? "#0066aa" : "#fff";
    scaleEls.push(
      `<rect x="${x}" y="${imperialBarY}" width="${impSegUnits}" height="${barH}" fill="${fill}" stroke="#0066aa" stroke-width="${scaleSW * 0.7}"/>`
    );
  }

  // Tick marks
  // Left edge (shared, full height of both bars)
  scaleEls.push(`<line x1="${barX0}" y1="${metricBarY - tickExt}" x2="${barX0}" y2="${imperialBarY + barH + tickExt}" stroke="#444" stroke-width="${scaleSW}"/>`);
  // Right edge of metric bar
  scaleEls.push(`<line x1="${barX0 + barUnits}" y1="${metricBarY - tickExt}" x2="${barX0 + barUnits}" y2="${metricBarY + barH}" stroke="#444" stroke-width="${scaleSW}"/>`);
  // Right edge of imperial bar
  scaleEls.push(`<line x1="${barX0 + imperialBarUnits}" y1="${imperialBarY}" x2="${barX0 + imperialBarUnits}" y2="${imperialBarY + barH + tickExt}" stroke="#0066aa" stroke-width="${scaleSW}"/>`);

  // Metric label above bar — right-aligned over the end of the bar
  const metricLabel = formatMetric(spec.barLengthMM);
  scaleEls.push(`<text x="${barX0 + barUnits}" y="${metricLabelY}" font-size="${scaleFontSize}" fill="#444" text-anchor="end" font-family="sans-serif">${metricLabel}</text>`);

  // Imperial label below bar — right-aligned over the end of the blue bar
  scaleEls.push(`<text x="${barX0 + imperialBarUnits}" y="${imperialLabelY}" font-size="${scaleFontSize}" fill="#0066aa" text-anchor="end" font-family="sans-serif">${imperialMil}mil</text>`);

  // Package title with margin below
  if (pkgTitle) {
    scaleEls.push(`<text x="${scaleCX}" y="${pkgLabelY}" font-size="${scaleFontSize * 2}" fill="#999" text-anchor="middle" font-family="sans-serif">${pkgTitle}</text>`);
  }

  // --- SOT-23-6 reference (popup only, ≥200px viewport) ---
  const refEls: string[] = [];
  // SOT-23-6 dimensions in EasyEDA units
  const sotBodyW = 11.42, sotBodyH = 6.30;
  const sotPadW = 2.09, sotPadH = 4.22;
  const sotPitch = 3.74;
  const sotRowHalf = 9.048 / 2; // 4.524 — half of row center-to-center spacing
  const sotPads: [number, number][] = [
    [-sotPitch, sotRowHalf],   // pin 1 — bottom-left
    [0, sotRowHalf],           // pin 2 — bottom-center
    [sotPitch, sotRowHalf],    // pin 3 — bottom-right
    [sotPitch, -sotRowHalf],   // pin 4 — top-right
    [0, -sotRowHalf],          // pin 5 — top-center
    [-sotPitch, -sotRowHalf],  // pin 6 — top-left
  ];

  // Body rect
  refEls.push(`<rect x="${-sotBodyW / 2}" y="${-sotBodyH / 2}" width="${sotBodyW}" height="${sotBodyH}" fill="#f0f0f0" stroke="#999" stroke-width="0.3"/>`);
  // Pads
  for (const [px, py] of sotPads) {
    refEls.push(`<rect x="${px - sotPadW / 2}" y="${py - sotPadH / 2}" width="${sotPadW}" height="${sotPadH}" fill="#c87137"/>`);
  }
  // Pin-1 dot marker
  const pin1DotR = sotPadW * 0.25;
  refEls.push(`<circle cx="${sotPads[0][0]}" cy="${sotPads[0][1] + sotPadH / 2 + pin1DotR * 1.5}" r="${pin1DotR}" fill="#888"/>`);
  // Label below
  const sotLabelY = sotRowHalf + sotPadH / 2 + pin1DotR * 3 + 1.5;
  refEls.push(`<text x="0" y="${sotLabelY}" font-size="2.5" fill="#888" text-anchor="middle" font-family="sans-serif">SOT-23-6</text>`);

  const sotTotalW = sotBodyW + sotPadW * 2; // ~15.6 EasyEDA units

  // Scale SOT-23-6 to match the footprint's coordinate system.
  // Target: SOT-23-6 should appear at roughly real-world scale relative to the footprint.
  // The SOT-23-6 is ~3mm × 3mm in real life = ~11.8 × 11.8 EasyEDA units.
  // No artificial scaling needed — it's already in the same unit system.
  // Just position it to the right of the footprint, vertically centered.
  const refX = maxX + padding * 0.8 + sotTotalW / 2;
  const refY = minY + bh / 2;

  const refGroup = `<g opacity="0.25" transform="translate(${refX},${refY})">${refEls.join("")}</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}"><rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="white"/>${refGroup}${elements.join("")}${labels.join("")}${scaleEls.join("")}</svg>`;
}

fpRouter.get("/:lcsc", async (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  if (!/^C\d+$/.test(lcsc)) return c.notFound();
  const pkgName = c.req.query("pkg") || undefined;

  const cachePath = svgCachePath(lcsc);

  if (existsSync(cachePath)) {
    const svg = Bun.file(cachePath);
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=2592000",
      },
    });
  }

  if (isOnCooldown(lcsc)) return c.newResponse(null, 404);

  // Fetch footprint from EasyEDA API
  try {
    const resp = await fetch(`https://easyeda.com/api/products/${lcsc}/components`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://easyeda.com/",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (resp.ok) {
      const json = await resp.json() as Record<string, unknown>;
      const result = json?.result as Record<string, unknown> | undefined;
      const pkgDataStr = (result?.packageDetail as Record<string, unknown>)?.dataStr;
      if (pkgDataStr) {
        const data = typeof pkgDataStr === "string" ? JSON.parse(pkgDataStr) : pkgDataStr;
        const svg = renderFootprintSvg(data as Record<string, unknown>, pkgName);
        if (svg) {
          mkdirSync(IMG_DIR, { recursive: true });
          writeFileSync(cachePath, svg);
          return new Response(svg, {
            headers: {
              "Content-Type": "image/svg+xml",
              "Cache-Control": "public, max-age=2592000",
            },
          });
        }
      }
    }
  } catch { /* network errors — fall through to 404 */ }

  // No footprint available — record so we don't retry for 24h
  markNoFp(lcsc);
  return c.newResponse(null, 404);
});
