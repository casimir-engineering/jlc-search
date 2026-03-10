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

function renderFootprintSvg(data: Record<string, unknown>): string | null {
  const shapes = (data.shape as string[]) ?? [];

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
  const scaleBarExtra = maxDim * 0.15 + 2;
  const bottomPadding = padding + scaleBarExtra;

  const vx = minX - padding, vy = minY - padding;
  const vw = bw + 2 * padding, vh = bh + padding + bottomPadding;

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

  // --- Scale bar (always visible) ---
  const scaleEls: string[] = [];
  const footprintWidthMM = bw * UNIT_TO_MM;
  const scaleOptions = [0.5, 1, 2, 5, 10, 20, 50];
  let scaleMM = scaleOptions[0];
  for (const opt of scaleOptions) {
    if (opt <= footprintWidthMM * 0.4) scaleMM = opt;
  }
  const scaleUnits = scaleMM / UNIT_TO_MM;
  const scaleMil = Math.round(scaleMM / 0.0254);

  const scaleSW = Math.max(maxDim * 0.003, 0.15);
  const tickH = maxDim * 0.05;
  const scaleCX = minX + bw / 2;
  const scaleY = maxY + padding * 0.5 + scaleBarExtra * 0.35;
  const scaleX1 = scaleCX - scaleUnits / 2;
  const scaleX2 = scaleCX + scaleUnits / 2;
  const scaleFontSize = Math.max(maxDim * 0.045, 0.8);

  scaleEls.push(`<line x1="${scaleX1}" y1="${scaleY}" x2="${scaleX2}" y2="${scaleY}" stroke="#888" stroke-width="${scaleSW}"/>`);
  scaleEls.push(`<line x1="${scaleX1}" y1="${scaleY - tickH / 2}" x2="${scaleX1}" y2="${scaleY + tickH / 2}" stroke="#888" stroke-width="${scaleSW}"/>`);
  scaleEls.push(`<line x1="${scaleX2}" y1="${scaleY - tickH / 2}" x2="${scaleX2}" y2="${scaleY + tickH / 2}" stroke="#888" stroke-width="${scaleSW}"/>`);
  scaleEls.push(`<text x="${scaleCX}" y="${scaleY + tickH / 2 + scaleFontSize * 1.2}" font-size="${scaleFontSize}" fill="#666" text-anchor="middle" font-family="sans-serif">${scaleMM}mm / ${scaleMil}mil</text>`);

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

  // Center the reference behind the actual footprint
  const refX = minX + bw / 2;
  const refY = minY + bh / 2;

  const style = `<style>.sot-ref{display:none}@media(min-width:200px){.sot-ref{display:block}}</style>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}">${style}<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="white"/><g class="sot-ref" opacity="0.4" transform="translate(${refX},${refY})">${refEls.join("")}</g>${elements.join("")}${labels.join("")}${scaleEls.join("")}</svg>`;
}

fpRouter.get("/:lcsc", async (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  if (!/^C\d+$/.test(lcsc)) return c.notFound();

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
        const svg = renderFootprintSvg(data as Record<string, unknown>);
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
