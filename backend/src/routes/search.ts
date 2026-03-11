import { Hono } from "hono";
import { search } from "../search/engine.ts";
import { refreshFromLcsc } from "../lcsc.ts";
import type { SearchResponse } from "../types.ts";

export const searchRouter = new Hono();

searchRouter.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 500);
  const partType = (c.req.queries("partType") ?? []).slice(0, 10);
  const inStock = c.req.query("inStock") === "true";
  const economic = c.req.query("economic") === "true";
  const fuzzy = c.req.query("fuzzy") === "true";
  const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "50") || 50), 200);
  const offset = Math.min(Math.max(0, parseInt(c.req.query("offset") ?? "0") || 0), 100_000);
  const sortRaw = c.req.query("sort") ?? "relevance";
  const sort = ["relevance", "price_asc", "price_desc", "stock_desc", "stock_asc"].includes(sortRaw)
    ? sortRaw as "relevance" | "price_asc" | "price_desc" | "stock_desc" | "stock_asc"
    : "relevance" as const;
  const matchAll = c.req.query("matchAll") === "true";

  if (q.trim().length === 0) {
    return c.json<SearchResponse>({ results: [], total: 0, took_ms: 0, query: q });
  }

  const start = performance.now();
  try {
    const { results, total } = await search({ q, partTypes: partType, inStock, economic, fuzzy, limit, offset, sort, matchAll });
    const took_ms = Math.round(performance.now() - start);

    // Opportunistic non-blocking refresh for parts missing MOQ/pricing
    for (const r of results) {
      if ((r as any).moq == null) refreshFromLcsc((r as any).lcsc);
    }

    return c.json<SearchResponse>({ results, total, took_ms, query: q });
  } catch (err) {
    console.error("Search route error:", err);
    return c.json<SearchResponse>({ results: [], total: 0, took_ms: Math.round(performance.now() - start), query: q });
  }
});
