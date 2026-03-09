import { Hono } from "hono";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { getSql } from "../db.ts";

export const imgRouter = new Hono();

const IMG_DIR = process.env.IMG_CACHE_DIR
  ?? join(import.meta.dir, "../../../data/img");

const LCSC_CDN = "https://assets.lcsc.com/images/lcsc/900x900/";

const LCSC_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.lcsc.com/",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
};

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

// Track in-flight downloads to avoid duplicate fetches
const downloading = new Set<string>();

function imgCachePath(lcsc: string): string {
  return join(IMG_DIR, `${lcsc}.jpg`);
}

function noImgPath(lcsc: string): string {
  return join(IMG_DIR, `${lcsc}.noimg`);
}

/** Returns true if a failed attempt was recorded within the last 24h. */
function isOnCooldown(lcsc: string): boolean {
  const p = noImgPath(lcsc);
  if (!existsSync(p)) return false;
  try {
    const ts = parseInt(readFileSync(p, "utf8"));
    if (Date.now() - ts < RETRY_AFTER_MS) return true;
    // Cooldown expired — remove marker so we retry
    unlinkSync(p);
  } catch {
    // Corrupted marker — ignore, allow retry
  }
  return false;
}

/** Record that a download attempt produced no image. */
function markNoImg(lcsc: string): void {
  try {
    mkdirSync(IMG_DIR, { recursive: true });
    writeFileSync(noImgPath(lcsc), Date.now().toString());
  } catch { /* ignore */ }
}

/** Look up the img filename from the DB (fast path — no HTML scraping needed). */
async function getImgFilename(lcsc: string): Promise<string | null> {
  const sql = getSql();
  const rows = await sql`SELECT img FROM parts WHERE lcsc = ${lcsc}`;
  return (rows[0]?.img as string) ?? null;
}

/** Fetch image from LCSC in the background and cache it to disk. */
async function downloadImage(lcsc: string): Promise<void> {
  if (downloading.has(lcsc)) return;
  downloading.add(lcsc);
  let succeeded = false;
  try {
    // Try DB img field first — direct CDN URL, no HTML scraping needed
    const imgFilename = await getImgFilename(lcsc);
    let cdnUrl: string | null = null;

    if (imgFilename) {
      cdnUrl = LCSC_CDN + imgFilename;
    } else {
      // Fall back to scraping product detail page
      const pageResp = await fetch(`https://www.lcsc.com/product-detail/${lcsc}.html`, {
        headers: LCSC_HEADERS,
        signal: AbortSignal.timeout(15_000),
      });
      if (!pageResp.ok) return;
      const html = await pageResp.text();
      const match = html.match(/https:\/\/assets\.lcsc\.com\/images\/lcsc\/[^\s"'<>]+\.jpg/i);
      if (!match) return;
      cdnUrl = match[0];
    }

    // Download the image
    const imgResp = await fetch(cdnUrl, {
      headers: { ...LCSC_HEADERS, Accept: "image/webp,image/jpeg,image/*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!imgResp.ok) return;
    const buf = await imgResp.arrayBuffer();
    if (buf.byteLength < 500) return;

    // Save to cache
    mkdirSync(IMG_DIR, { recursive: true });
    writeFileSync(imgCachePath(lcsc), Buffer.from(buf));
    succeeded = true;
  } catch {
    // Network errors, timeouts — silently ignored
  } finally {
    downloading.delete(lcsc);
    if (!succeeded) markNoImg(lcsc);
  }
}

imgRouter.get("/:lcsc", (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  if (!/^C\d+$/.test(lcsc)) return c.notFound();

  const cachePath = imgCachePath(lcsc);

  if (existsSync(cachePath)) {
    const file = Bun.file(cachePath);
    return new Response(file, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=2592000", // 30 days
      },
    });
  }

  // If we tried recently and got nothing, don't hammer LCSC again
  if (isOnCooldown(lcsc)) return c.newResponse(null, 404);

  // Kick off background download and tell client to retry
  downloadImage(lcsc); // intentionally not awaited
  return c.newResponse(null, 404);
});
