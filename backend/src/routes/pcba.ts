import { Hono } from "hono";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { getDb } from "../db.ts";

export const pcbaRouter = new Hono();

const CACHE_DIR = process.env.IMG_CACHE_DIR
  ?? join(import.meta.dir, "../../../data/img");

interface PcbaInfo {
  pcba_type: string;
  assembly_type: string;
  description: string;
}

function cachePath(lcsc: string): string {
  return join(CACHE_DIR, `${lcsc}.pcba`);
}

function getCached(lcsc: string): PcbaInfo | null {
  const p = cachePath(lcsc);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // Legacy plain-text cache from before — delete and re-fetch
    return null;
  }
}

async function fetchPcbaInfo(lcsc: string): Promise<PcbaInfo | null> {
  try {
    const res = await fetch(`https://jlcpcb.com/partdetail/_/${lcsc}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const pcba = html.match(/PCBA Type<\/dt>\s*<dd[^>]*><span[^>]*>([^<]+)<\/span>/);
    const asm = html.match(/Assembly Type<\/dt>\s*<dd[^>]*><span[^>]*>([^<]+)<\/span>/);
    const desc = html.match(/Description<\/dt>\s*<dd[^>]*>([^<]+)/);
    if (!pcba && !asm) return null;
    return {
      pcba_type: pcba?.[1]?.trim() ?? "unknown",
      assembly_type: asm?.[1]?.trim() ?? "unknown",
      description: desc?.[1]?.trim() ?? "",
    };
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<PcbaInfo | null>>();

pcbaRouter.get("/:lcsc", async (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!lcsc) return c.json({ error: "missing lcsc" }, 400);

  const cached = getCached(lcsc);
  if (cached) {
    return c.json({ lcsc, ...cached });
  }

  let promise = inflight.get(lcsc);
  if (!promise) {
    promise = fetchPcbaInfo(lcsc);
    inflight.set(lcsc, promise);
  }

  const result = await promise;
  inflight.delete(lcsc);

  if (result) {
    writeFileSync(cachePath(lcsc), JSON.stringify(result));
    if (result.description) {
      try {
        getDb().run("UPDATE parts SET description = ? WHERE lcsc = ?", [result.description, lcsc]);
      } catch {}
    }
    return c.json({ lcsc, ...result });
  }

  const fallback: PcbaInfo = { pcba_type: "unknown", assembly_type: "unknown", description: "" };
  writeFileSync(cachePath(lcsc), JSON.stringify(fallback));
  return c.json({ lcsc, ...fallback });
});
