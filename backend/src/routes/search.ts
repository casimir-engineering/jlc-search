import { Hono } from "hono";
import { search } from "../search/engine.ts";
import type { SearchResponse } from "../types.ts";

export const searchRouter = new Hono();

searchRouter.get("/", (c) => {
  const q = c.req.query("q") ?? "";
  const partType = c.req.queries("partType") ?? [];
  const inStock = c.req.query("inStock") === "true";
  const fuzzy = c.req.query("fuzzy") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const sortRaw = c.req.query("sort") ?? "relevance";
  const sort = ["relevance", "price_asc", "price_desc", "stock_desc", "stock_asc"].includes(sortRaw)
    ? sortRaw as "relevance" | "price_asc" | "price_desc" | "stock_desc" | "stock_asc"
    : "relevance" as const;

  if (q.trim().length === 0) {
    return c.json<SearchResponse>({ results: [], total: 0, took_ms: 0, query: q });
  }

  const start = performance.now();
  const { results, total } = search({ q, partTypes: partType, inStock, fuzzy, limit, offset, sort });
  const took_ms = Math.round(performance.now() - start);

  return c.json<SearchResponse>({ results, total, took_ms, query: q });
});
