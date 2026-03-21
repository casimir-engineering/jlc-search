import { Hono } from "hono";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { getSql } from "../db.ts";

export const pcbaRouter = new Hono();

const CACHE_DIR = process.env.IMG_CACHE_DIR
  ?? join(import.meta.dir, "../../data/img");

interface PcbaInfo {
  pcba_type: string;
  assembly_type: string;
  description: string;
  jlc_stock: number | null;
}

function cachePath(lcsc: string): string {
  return join(CACHE_DIR, `${lcsc}.pcba`);
}

function getCached(lcsc: string): PcbaInfo | null {
  const p = cachePath(lcsc);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return {
      pcba_type: data.pcba_type ?? "unknown",
      assembly_type: data.assembly_type ?? "unknown",
      description: data.description ?? "",
      jlc_stock: data.jlc_stock ?? null,
    };
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

    // Extract JLC stock — try JSON embedded data first, then HTML element
    const stockJson = html.match(/"stockCount"\s*:\s*(\d+)/);
    const stockHtml = html.match(/Stock<\/dt>\s*<dd[^>]*>(?:<[^>]*>)*\s*([0-9,]+)/);
    const jlcStockStr = stockJson?.[1] ?? stockHtml?.[1]?.replace(/,/g, '') ?? null;
    const jlc_stock = jlcStockStr ? parseInt(jlcStockStr) : null;

    return {
      pcba_type: pcba?.[1]?.trim() ?? "unknown",
      assembly_type: asm?.[1]?.trim() ?? "unknown",
      description: desc?.[1]?.trim() ?? "",
      jlc_stock,
    };
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<PcbaInfo | null>>();

pcbaRouter.get("/:lcsc", async (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^C\d+$/.test(lcsc)) return c.json({ error: "Invalid LCSC code" }, 400);

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
    if (result.pcba_type !== "unknown" || result.description || (result.jlc_stock != null && result.jlc_stock > 0)) {
      try {
        const sql = getSql();
        const normalizedPcba = result.pcba_type.replace(" and ", "+");
        const hasStock = result.jlc_stock != null && result.jlc_stock > 0;
        if (result.pcba_type !== "unknown" && result.description && hasStock) {
          await sql`UPDATE parts SET pcba_type = ${normalizedPcba}, description = ${result.description}, jlc_stock = ${result.jlc_stock} WHERE lcsc = ${lcsc}`;
        } else if (result.pcba_type !== "unknown" && result.description) {
          await sql`UPDATE parts SET pcba_type = ${normalizedPcba}, description = ${result.description} WHERE lcsc = ${lcsc}`;
        } else if (result.pcba_type !== "unknown" && hasStock) {
          await sql`UPDATE parts SET pcba_type = ${normalizedPcba}, jlc_stock = ${result.jlc_stock} WHERE lcsc = ${lcsc}`;
        } else if (result.description && hasStock) {
          await sql`UPDATE parts SET description = ${result.description}, jlc_stock = ${result.jlc_stock} WHERE lcsc = ${lcsc}`;
        } else if (result.pcba_type !== "unknown") {
          await sql`UPDATE parts SET pcba_type = ${normalizedPcba} WHERE lcsc = ${lcsc}`;
        } else if (result.description) {
          await sql`UPDATE parts SET description = ${result.description} WHERE lcsc = ${lcsc}`;
        } else if (hasStock) {
          await sql`UPDATE parts SET jlc_stock = ${result.jlc_stock} WHERE lcsc = ${lcsc}`;
        }
      } catch {}
    }
    return c.json({ lcsc, ...result });
  }

  const fallback: PcbaInfo = { pcba_type: "unknown", assembly_type: "unknown", description: "", jlc_stock: null };
  writeFileSync(cachePath(lcsc), JSON.stringify(fallback));
  return c.json({ lcsc, ...fallback });
});
