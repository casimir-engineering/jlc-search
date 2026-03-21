import { Hono } from "hono";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";

export const schRouter = new Hono();

const IMG_DIR = process.env.IMG_CACHE_DIR
  ?? join(import.meta.dir, "../../data/img");

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

// Track in-flight fetches to avoid duplicate requests
const fetching = new Set<string>();

function svgCachePath(lcsc: string): string {
  return join(IMG_DIR, `${lcsc}.sch.svg`);
}

function noSchPath(lcsc: string): string {
  return join(IMG_DIR, `${lcsc}.nosch`);
}

function isOnCooldown(lcsc: string): boolean {
  const p = noSchPath(lcsc);
  if (!existsSync(p)) return false;
  try {
    const ts = parseInt(readFileSync(p, "utf8"));
    if (Date.now() - ts < RETRY_AFTER_MS) return true;
    unlinkSync(p);
  } catch { /* ignore */ }
  return false;
}

function markNoSch(lcsc: string): void {
  try {
    mkdirSync(IMG_DIR, { recursive: true });
    writeFileSync(noSchPath(lcsc), Date.now().toString());
  } catch { /* ignore */ }
}

// KiCad default color scheme (matches KiCad 8 defaults)
const COL = {
  bodyStroke: "#840000",   // dark red/maroon body outline
  bodyFill: "#FFFFCC",     // light yellow fill
  pin: "#008400",          // green pin lines
  pinName: "#008484",      // teal/cyan pin names
  pinNum: "#840000",       // dark red pin numbers
  dot: "#008400",          // green pin-1 dot
  bg: "#FFFFFF",           // white background
  arrow: "#008400",        // green arrows
  text: "#008484",         // teal text
  line: "#840000",         // dark red body lines
};

/** Extract all numeric coordinates from an SVG path string (M, L, h, v, etc.) */
function extractPathPoints(d: string): { x: number[]; y: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];

  // Tokenize: split on commands, keeping command letters
  const tokens = d.match(/[MLHVCSTQAZmlhvcsqaz]|[-+]?(?:\d+\.?\d*|\.\d+)/g);
  if (!tokens) return { x: xs, y: ys };

  let curX = 0, curY = 0;
  let cmd = "M";
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z]$/.test(tok)) {
      cmd = tok;
      i++;
      continue;
    }

    const n = parseFloat(tok);
    switch (cmd) {
      case "M":
      case "L":
        curX = n;
        curY = parseFloat(tokens[++i] ?? "0");
        xs.push(curX); ys.push(curY);
        i++;
        break;
      case "m":
      case "l":
        curX += n;
        curY += parseFloat(tokens[++i] ?? "0");
        xs.push(curX); ys.push(curY);
        i++;
        break;
      case "H":
        curX = n;
        xs.push(curX); ys.push(curY);
        i++;
        break;
      case "h":
        curX += n;
        xs.push(curX); ys.push(curY);
        i++;
        break;
      case "V":
        curY = n;
        xs.push(curX); ys.push(curY);
        i++;
        break;
      case "v":
        curY += n;
        xs.push(curX); ys.push(curY);
        i++;
        break;
      default:
        // For A, C, S, T, Q — just skip numbers, they contribute coords
        // but are complex; collect them as absolute if uppercase
        if (cmd === cmd.toUpperCase()) {
          xs.push(n);
          if (i + 1 < tokens.length && /^[-+]?[\d.]/.test(tokens[i + 1])) {
            ys.push(parseFloat(tokens[++i]));
          }
        }
        i++;
        break;
    }
  }

  return { x: xs, y: ys };
}

/** Escape XML special characters */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

function renderSchematicSvg(data: Record<string, unknown>): string | null {
  const shapes = (data.shape as string[]) ?? [];
  if (shapes.length === 0) return null;

  const allX: number[] = [];
  const allY: number[] = [];

  // First pass: collect bounding box
  for (const shape of shapes) {
    const f = shape.split("~");
    const type = f[0];

    if (type === "R") {
      // R~x~y~rx~ry~width~height~...
      const x = parseFloat(f[1]), y = parseFloat(f[2]);
      const w = parseFloat(f[5]), h = parseFloat(f[6]);
      if (!isNaN(x) && !isNaN(w)) {
        allX.push(x, x + w);
        allY.push(y, y + h);
      }
    } else if (type === "E") {
      // E~cx~cy~rx~ry~...
      const cx = parseFloat(f[1]), cy = parseFloat(f[2]);
      const rx = parseFloat(f[3]), ry = parseFloat(f[4]);
      if (!isNaN(cx)) {
        allX.push(cx - rx, cx + rx);
        allY.push(cy - ry, cy + ry);
      }
    } else if (type === "P") {
      // Pin — split on ^^ to get parts
      const parts = shape.split("^^");
      // Part 0 header: P~show~elecType~pinNum~tipX~tipY~rotation~id~locked
      const hdr = parts[0].split("~");
      const tipX = parseFloat(hdr[4]), tipY = parseFloat(hdr[5]);
      if (!isNaN(tipX)) {
        allX.push(tipX);
        allY.push(tipY);
      }
      // Part 2: svgPath~color — parse path for endpoints
      if (parts[2]) {
        const pathParts = parts[2].split("~");
        const pathD = pathParts[0];
        if (pathD) {
          const pts = extractPathPoints(pathD);
          allX.push(...pts.x);
          allY.push(...pts.y);
        }
      }
      // Part 3: pin name text position
      if (parts[3]) {
        const nameF = parts[3].split("~");
        const nx = parseFloat(nameF[1]), ny = parseFloat(nameF[2]);
        if (!isNaN(nx)) { allX.push(nx); allY.push(ny); }
      }
      // Part 4: pin number text position
      if (parts[4]) {
        const numF = parts[4].split("~");
        const nx = parseFloat(numF[1]), ny = parseFloat(numF[2]);
        if (!isNaN(nx)) { allX.push(nx); allY.push(ny); }
      }
    } else if (type === "L") {
      // L~x1~y1~x2~y2~...
      const x1 = parseFloat(f[1]), y1 = parseFloat(f[2]);
      const x2 = parseFloat(f[3]), y2 = parseFloat(f[4]);
      if (!isNaN(x1)) { allX.push(x1, x2); allY.push(y1, y2); }
    } else if (type === "PL" || type === "PG") {
      // PL~x1 y1 x2 y2 ...~...  or  PG~x1 y1 x2 y2 ...~color~sw~rot~fill~id~locked
      const pts = f[1]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
      for (let i = 0; i + 1 < pts.length; i += 2) {
        if (!isNaN(pts[i])) { allX.push(pts[i]); allY.push(pts[i + 1]); }
      }
    } else if (type === "A" || type === "PT") {
      // A~svgPath~...  or  PT~svgPath~color~strokeWidth~rotation~fillColor~id~locked
      const pathD = f[1];
      if (pathD) {
        const pts = extractPathPoints(pathD);
        allX.push(...pts.x);
        allY.push(...pts.y);
      }
    } else if (type === "T") {
      // T~type~x~y~...
      const tx = parseFloat(f[2]), ty = parseFloat(f[3]);
      if (!isNaN(tx)) { allX.push(tx); allY.push(ty); }
    }
  }

  if (allX.length === 0) return null;

  const minX = arrayMin(allX), maxX = arrayMax(allX);
  const minY = arrayMin(allY), maxY = arrayMax(allY);
  const bw = maxX - minX || 10, bh = maxY - minY || 10;
  const maxDim = Math.max(bw, bh);
  const padding = maxDim * 0.12 + 3;

  const vx = minX - padding, vy = minY - padding;
  const vw = bw + 2 * padding, vh = bh + 2 * padding;

  // Font size: ~3.5% of max dimension, with minimum
  const fontSize = +Math.max(maxDim * 0.035, 2).toFixed(2);
  const strokeW = +Math.max(maxDim * 0.004, 0.3).toFixed(2);

  // Second pass: build SVG elements
  const bodyEls: string[] = [];
  const pinEls: string[] = [];
  const textEls: string[] = [];

  for (const shape of shapes) {
    const f = shape.split("~");
    const type = f[0];

    if (type === "R") {
      const x = parseFloat(f[1]), y = parseFloat(f[2]);
      const rx = parseFloat(f[3]) || 0, ry = parseFloat(f[4]) || 0;
      const w = parseFloat(f[5]), h = parseFloat(f[6]);
      const sw = parseFloat(f[8]) || strokeW;
      const rot = parseFloat(f[9]) || 0;
      if (isNaN(x) || isNaN(w)) continue;
      const rotAttr = rot !== 0 ? ` transform="rotate(${rot},${x + w / 2},${y + h / 2})"` : "";
      bodyEls.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${ry}" stroke="${COL.bodyStroke}" stroke-width="${sw}" fill="${COL.bodyFill}"${rotAttr}/>`
      );
    } else if (type === "E") {
      const cx = parseFloat(f[1]), cy = parseFloat(f[2]);
      const rx = parseFloat(f[3]), ry = parseFloat(f[4]);
      const sw = parseFloat(f[6]) || strokeW;
      if (isNaN(cx)) continue;
      // Pin 1 indicator dot
      bodyEls.push(
        `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" stroke="${COL.dot}" stroke-width="${sw}" fill="${COL.dot}"/>`
      );
    } else if (type === "P") {
      const parts = shape.split("^^");

      // Part 2: pin line path
      if (parts[2]) {
        const pathParts = parts[2].split("~");
        const pathD = pathParts[0];
        if (pathD) {
          pinEls.push(
            `<path d="${esc(pathD)}" stroke="${COL.pin}" stroke-width="${strokeW}" fill="none" stroke-linecap="round"/>`
          );
        }
      }

      // Part 3: pin name text
      // Field [0] is the "show" flag from EasyEDA header, not a visibility toggle for the text.
      // Render whenever text content exists.
      if (parts[3]) {
        const nameF = parts[3].split("~");
        const nx = parseFloat(nameF[1]), ny = parseFloat(nameF[2]);
        const rot = parseFloat(nameF[3]) || 0;
        const name = nameF[4] ?? "";
        const align = nameF[5] ?? "start";
        if (!isNaN(nx) && name) {
          const anchor = align === "end" ? "end" : align === "middle" ? "middle" : "start";
          const rotAttr = rot !== 0 ? ` transform="rotate(${rot},${nx},${ny})"` : "";
          textEls.push(
            `<text x="${nx}" y="${ny}" font-size="${fontSize}" fill="${COL.pinName}" text-anchor="${anchor}" dominant-baseline="central" font-family="sans-serif"${rotAttr}>${esc(name)}</text>`
          );
        }
      }

      // Part 4: pin number text
      if (parts[4]) {
        const numF = parts[4].split("~");
        const nx = parseFloat(numF[1]), ny = parseFloat(numF[2]);
        const rot = parseFloat(numF[3]) || 0;
        const pinNum = numF[4] ?? "";
        const align = numF[5] ?? "start";
        if (!isNaN(nx) && pinNum) {
          const anchor = align === "end" ? "end" : align === "middle" ? "middle" : "start";
          const rotAttr = rot !== 0 ? ` transform="rotate(${rot},${nx},${ny})"` : "";
          textEls.push(
            `<text x="${nx}" y="${ny}" font-size="${+(fontSize * 0.9).toFixed(2)}" fill="${COL.pinNum}" text-anchor="${anchor}" dominant-baseline="central" font-family="sans-serif"${rotAttr}>${esc(pinNum)}</text>`
          );
        }
      }

      // Part 5: dot/clock indicator position (type 0=none)
      // Part 6: arrow/indicator path
      if (parts[6]) {
        const arrowF = parts[6].split("~");
        const arrowType = arrowF[0];
        const arrowPath = arrowF[1];
        if (arrowType !== "0" && arrowPath) {
          pinEls.push(
            `<path d="${esc(arrowPath)}" stroke="${COL.pin}" stroke-width="${strokeW}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
          );
        }
      }
    } else if (type === "L") {
      const x1 = parseFloat(f[1]), y1 = parseFloat(f[2]);
      const x2 = parseFloat(f[3]), y2 = parseFloat(f[4]);
      const sw = parseFloat(f[6]) || strokeW;
      if (isNaN(x1)) continue;
      pinEls.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COL.line}" stroke-width="${sw}" stroke-linecap="round"/>`
      );
    } else if (type === "PL") {
      const pts = f[1]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
      const sw = parseFloat(f[3]) || strokeW;
      const fillColor = f[5] ?? "none";
      if (pts.length < 4) continue;
      const points: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) points.push(`${pts[i]},${pts[i + 1]}`);
      const fill = fillColor === "none" ? "none" : COL.bodyFill;
      pinEls.push(
        `<polyline points="${points.join(" ")}" stroke="${COL.line}" stroke-width="${sw}" fill="${fill}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    } else if (type === "PG") {
      // PG~x1 y1 x2 y2 ...~color~strokeWidth~rotation~fillColor~id~locked
      const pts = f[1]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? [];
      const sw = parseFloat(f[3]) || strokeW;
      const fillColor = f[5] ?? "none";
      if (pts.length < 4) continue;
      const points: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) points.push(`${pts[i]},${pts[i + 1]}`);
      const fill = fillColor === "none" ? "none" : COL.bodyStroke;
      bodyEls.push(
        `<polygon points="${points.join(" ")}" stroke="${COL.bodyStroke}" stroke-width="${sw}" fill="${fill}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    } else if (type === "A") {
      const pathD = f[1];
      const sw = parseFloat(f[3]) || strokeW;
      const fillColor = f[5] ?? "none";
      if (!pathD) continue;
      const fill = fillColor === "none" ? "none" : COL.bodyFill;
      pinEls.push(
        `<path d="${esc(pathD)}" stroke="${COL.line}" stroke-width="${sw}" fill="${fill}" stroke-linecap="round"/>`
      );
    } else if (type === "PT") {
      // PT~svgPath~color~strokeWidth~rotation~fillColor~id~locked
      const pathD = f[1];
      const sw = parseFloat(f[3]) || strokeW;
      const fillColor = f[5] ?? "none";
      if (!pathD) continue;
      const fill = fillColor === "none" ? "none" : COL.bodyStroke;
      bodyEls.push(
        `<path d="${esc(pathD)}" stroke="${COL.bodyStroke}" stroke-width="${sw}" fill="${fill}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    } else if (type === "T") {
      // T~type~x~y~rotation~fillColor~id~fontSize~fontFamily~fontWeight~fontStyle~textContent~...
      const tx = parseFloat(f[2]), ty = parseFloat(f[3]);
      const rot = parseFloat(f[4]) || 0;
      const tFontSize = parseFloat(f[7]) || fontSize;
      const fontWeight = f[9] ?? "normal";
      const textContent = f[11] ?? "";
      if (isNaN(tx) || !textContent) continue;
      const rotAttr = rot !== 0 ? ` transform="rotate(${rot},${tx},${ty})"` : "";
      textEls.push(
        `<text x="${tx}" y="${ty}" font-size="${tFontSize}" fill="${COL.text}" font-family="sans-serif" font-weight="${fontWeight}" dominant-baseline="central" text-anchor="middle"${rotAttr}>${esc(textContent)}</text>`
      );
    }
  }

  const elements = [...bodyEls, ...pinEls, ...textEls];
  if (elements.length === 0) return null;

  const r = (n: number) => +n.toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(vx)} ${r(vy)} ${r(vw)} ${r(vh)}"><rect x="${r(vx)}" y="${r(vy)}" width="${r(vw)}" height="${r(vh)}" fill="${COL.bg}"/>${elements.join("")}</svg>`;
}

/** Fetch schematic from EasyEDA in the background and cache it to disk. */
async function fetchSchematic(lcsc: string): Promise<void> {
  if (fetching.has(lcsc)) return;
  fetching.add(lcsc);
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
      const schDataStr = result?.dataStr;
      if (schDataStr) {
        const data = typeof schDataStr === "string" ? JSON.parse(schDataStr) : schDataStr;
        const svg = renderSchematicSvg(data as Record<string, unknown>);
        if (svg) {
          mkdirSync(IMG_DIR, { recursive: true });
          writeFileSync(svgCachePath(lcsc), svg);
          return;
        }
      }
    }
  } catch {
    // Network errors, timeouts — silently ignored
  } finally {
    fetching.delete(lcsc);
  }

  // No schematic available — record so we don't retry for 24h
  markNoSch(lcsc);
}

schRouter.get("/:lcsc", (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  if (!/^C\d+$/.test(lcsc)) return c.notFound();

  const cachePath = svgCachePath(lcsc);

  if (existsSync(cachePath)) {
    const svg = readFileSync(cachePath);
    return new Response(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=2592000",
        "Content-Length": String(svg.byteLength),
      },
    });
  }

  if (isOnCooldown(lcsc)) return c.newResponse(null, 404);

  if (!fetching.has(lcsc)) {
    fetchSchematic(lcsc); // intentionally not awaited
  }
  return c.newResponse(null, 404);
});
