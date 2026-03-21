import { Hono } from "hono";
import { search } from "../search/engine.ts";
import { refreshFromLcsc } from "../lcsc.ts";
import { refreshJlcStock } from "../jlcpcb-stock.ts";
import type { SearchResponse } from "../types.ts";

export const searchRouter = new Hono();

searchRouter.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 500);
  const partType = (c.req.queries("partType") ?? []).slice(0, 10);
  const stockFilterRaw = c.req.query("stockFilter") ?? "none";
  const stockFilter = ["none", "jlc", "lcsc", "any"].includes(stockFilterRaw)
    ? stockFilterRaw as "none" | "jlc" | "lcsc" | "any"
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
    return c.json<SearchResponse>({ results: [], total: 0, took_ms: 0, query: q });
  }

  const start = performance.now();
  try {
    const { results, total } = await search({ q, partTypes: partType, categories, stockFilter, economic, fuzzy, limit, offset, sort, matchAll });
    const took_ms = Math.round(performance.now() - start);

    // Opportunistic non-blocking refresh for parts missing MOQ/pricing or JLC stock
    for (const r of results) {
      if ((r as any).moq == null) refreshFromLcsc((r as any).lcsc);
      if ((r as any).jlc_stock === 0) refreshJlcStock((r as any).lcsc);
    }

    c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return c.json<SearchResponse>({ results, total, took_ms, query: q });
  } catch (err) {
    console.error("Search route error:", err);
    return c.json<SearchResponse>({ results: [], total: 0, took_ms: Math.round(performance.now() - start), query: q });
  }
});
