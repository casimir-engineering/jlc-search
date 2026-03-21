import { Hono } from "hono";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { getSql } from "../db.ts";

export const imgRouter = new Hono();

const IMG_DIR = process.env.IMG_CACHE_DIR
  ?? join(import.meta.dir, "../../data/img");

const LCSC_CDN = "https://assets.lcsc.com/images/lcsc/900x900/";
const WSRV_PROXY = "https://wsrv.nl/?url=";

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

/** Look up the img URL/filename from the DB (fast path — no HTML scraping needed). */
async function getImgField(lcsc: string): Promise<string | null> {
  const sql = getSql();
  const rows = await sql`SELECT img FROM parts WHERE lcsc = ${lcsc}`;
  return (rows[0]?.img as string) ?? null;
}

const JLCPCB_API = "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList";
const JLCPCB_FILE_API = "https://jlcpcb.com/api/file/downloadByFileSystemAccessId/";

/** Try JLCPCB accessId API — covers ~80% of parts, no auth needed. */
async function tryJlcpcbAccessId(lcsc: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(JLCPCB_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: lcsc, pageSize: 1, currentPage: 1 }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const part = data?.data?.componentPageInfo?.list?.[0];
    const accessId = part?.productBigImageAccessId || part?.minImageAccessId;
    if (!accessId) return null;

    const imgResp = await fetch(`${JLCPCB_FILE_API}${accessId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!imgResp.ok) return null;
    const buf = await imgResp.arrayBuffer();
    return buf.byteLength >= 500 ? buf : null;
  } catch { return null; }
}

/** Fetch image in background and cache to disk. Tries: JLCPCB accessId → direct CDN → wsrv.nl proxy. */
async function downloadImage(lcsc: string): Promise<void> {
  if (downloading.has(lcsc)) return;
  downloading.add(lcsc);
  let succeeded = false;
  try {
    let buf: ArrayBuffer | null = null;

    // Tier 1: JLCPCB accessId API (fastest, no IP block issues)
    buf = await tryJlcpcbAccessId(lcsc);

    // Tier 2: Direct LCSC CDN (works if not IP-blocked)
    if (!buf) {
      const imgField = await getImgField(lcsc);
      let cdnUrl: string | null = null;
      if (imgField) {
        cdnUrl = imgField.startsWith("http")
          ? imgField.replace("/96x96/", "/900x900/")
          : LCSC_CDN + imgField;
      }
      if (cdnUrl) {
        try {
          const imgResp = await fetch(cdnUrl, {
            headers: { ...LCSC_HEADERS, Accept: "image/webp,image/jpeg,image/*" },
            signal: AbortSignal.timeout(8_000),
          });
          if (imgResp.ok) {
            const data = await imgResp.arrayBuffer();
            if (data.byteLength >= 500) buf = data;
          }
        } catch { /* direct failed */ }

        // Tier 3: wsrv.nl proxy (bypasses CDN IP blocks)
        if (!buf) {
          try {
            const proxyUrl = `${WSRV_PROXY}${encodeURIComponent(cdnUrl)}&w=900&h=900`;
            const proxyResp = await fetch(proxyUrl, {
              signal: AbortSignal.timeout(15_000),
            });
            if (proxyResp.ok) {
              const data = await proxyResp.arrayBuffer();
              if (data.byteLength >= 500) buf = data;
            }
          } catch { /* proxy also failed */ }
        }
      }
    }

    if (!buf) return;

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
    const file = readFileSync(cachePath);
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=2592000",
        "Content-Length": String(file.byteLength),
      },
    });
  }

  // If we tried recently and got nothing, don't hammer LCSC again
  if (isOnCooldown(lcsc)) return c.newResponse(null, 404);

  // Kick off background download and tell client to retry
  downloadImage(lcsc); // intentionally not awaited
  return c.newResponse(null, 404);
});
