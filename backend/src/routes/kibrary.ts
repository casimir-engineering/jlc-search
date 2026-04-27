import { Hono } from "hono";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { kibraryAuth, kibraryRateLimit, type KibraryEnv } from "../middleware/kibrary-auth.ts";
import { getSql } from "../db.ts";
import { search } from "../search/engine.ts";
import { refreshFromLcsc } from "../lcsc.ts";
import { refreshJlcStock } from "../jlcpcb-stock.ts";
import { downloadImage, isOnCooldown } from "./img.ts";
import type { SearchResponse } from "../types.ts";

export const kibraryRouter = new Hono<KibraryEnv>();

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://search.raph.io";

const IMG_DIR = process.env.IMG_CACHE_DIR
  ?? join(import.meta.dir, "../../data/img");

function imgCachePath(lcsc: string): string {
  return join(IMG_DIR, `${lcsc}.jpg`);
}

// Auth on every kibrary route; per-route rate-limit buckets below.
kibraryRouter.use("*", kibraryAuth());
kibraryRouter.use("/search", kibraryRateLimit("search"));
kibraryRouter.use("/parts/*", kibraryRateLimit("part"));

// GET /search — wraps the public search and enriches each result with
// `photo_url` and `in_stock` for kibrary clients.
kibraryRouter.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 500);
  const partType = (c.req.queries("partType") ?? []).slice(0, 10);
  const stockFilterRaw = c.req.query("stockFilter") ?? "none";
  const stockFilter = ["none", "jlc", "lcsc", "any", "both"].includes(stockFilterRaw)
    ? stockFilterRaw as "none" | "jlc" | "lcsc" | "any" | "both"
    : "none" as const;
  const economic = c.req.query("economic") === "true";
  const fuzzy = c.req.query("fuzzy") === "true";
  const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "50") || 50), 500);
  const offset = Math.min(Math.max(0, parseInt(c.req.query("offset") ?? "0") || 0), 100_000);
  const sortRaw = c.req.query("sort") ?? "relevance";
  const sort = ["relevance", "price_asc", "price_desc", "stock_desc", "stock_asc"].includes(sortRaw)
    ? sortRaw as "relevance" | "price_asc" | "price_desc" | "stock_desc" | "stock_asc"
    : "relevance" as const;
  const matchAll = c.req.query("matchAll") === "true";
  const categories = (c.req.queries("category") ?? []).slice(0, 20);

  if (q.trim().length === 0) {
    return c.json({ results: [], total: 0, took_ms: 0, query: q });
  }

  const start = performance.now();
  const { results, total, categories: facetCategories } = await search({
    q, partTypes: partType, categories, stockFilter, economic, fuzzy, limit, offset, sort, matchAll,
  });
  const took_ms = Math.round(performance.now() - start);

  for (const r of results) {
    if ((r as any).moq == null) refreshFromLcsc(r.lcsc);
    if (r.jlc_stock === 0) refreshJlcStock(r.lcsc);
  }

  const enriched = results.map((r) => ({
    ...r,
    photo_url: r.img ? `${PUBLIC_BASE_URL}/api/img/${r.lcsc}` : null,
    in_stock: (r.stock ?? 0) > 0 || (r.jlc_stock ?? 0) > 0,
  }));

  const body: SearchResponse & { results: typeof enriched } = {
    results: enriched,
    total,
    took_ms,
    query: q,
    categories: facetCategories,
  };
  return c.json(body);
});

// GET /parts/batch — must be registered BEFORE /parts/:lcsc so the literal
// "batch" doesn't get matched as the :lcsc param.
kibraryRouter.get("/parts/batch", async (c) => {
  const lcscParam = c.req.query("lcsc");
  if (!lcscParam) return c.json({ error: "Missing lcsc query parameter" }, 400);
  const lcscs = lcscParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (lcscs.length === 0) return c.json({ parts: {} });
  if (lcscs.length > 100) return c.json({ error: "Batch limit is 100 LCSCs" }, 400);

  const sql = getSql();
  const rows = await sql`
    SELECT lcsc, mpn, manufacturer, category, subcategory, description,
           datasheet, package, joints, stock, jlc_stock, price_raw, img, url,
           part_type, pcba_type, moq, attributes
    FROM parts WHERE lcsc = ANY(${lcscs}::text[])
  `;

  const byLcsc = new Map<string, any>(rows.map((r: any) => [r.lcsc, r]));
  const parts: Record<string, any> = {};
  for (const lcsc of lcscs) {
    parts[lcsc] = byLcsc.get(lcsc) ?? null;
  }
  return c.json({ parts });
});

// GET /parts/:lcsc — passthrough of public part-detail response shape.
kibraryRouter.get("/parts/:lcsc", async (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  if (!/^C\d+$/.test(lcsc)) return c.json({ error: "Invalid LCSC code" }, 400);
  const sql = getSql();

  const rows = await sql`
    SELECT lcsc, mpn, manufacturer, category, subcategory, description,
           datasheet, package, joints, stock, jlc_stock, price_raw, img, url,
           part_type, pcba_type, moq, attributes
    FROM parts WHERE lcsc = ${lcsc}
  `;

  if (rows.length === 0) {
    return c.json({ error: "Part not found" }, 404);
  }

  refreshFromLcsc(lcsc);
  if ((rows[0] as any).jlc_stock === 0) refreshJlcStock(lcsc);
  return c.json(rows[0]);
});

// GET /parts/:lcsc/photo — mirrors the public imgRouter behavior by sharing
// its cache, cooldown marker, and download helper. Same on-disk state, so
// requests through either route warm the same cache.
kibraryRouter.get("/parts/:lcsc/photo", (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  if (!/^C\d+$/.test(lcsc)) return c.newResponse(null, 404);

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

  if (isOnCooldown(lcsc)) return c.newResponse(null, 404);

  downloadImage(lcsc);
  return c.newResponse(null, 404);
});
