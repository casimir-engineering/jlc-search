import { getDb } from "../db.ts";
import { buildFtsQuery, buildFtsOrQuery, detectLcscCode, parseQuery, type RangeFilter } from "./parser.ts";
import type { PartSummary, SearchParams } from "../types.ts";

const SELECT_COLS = `
  p.lcsc, p.mpn, p.manufacturer, p.description, p.package, p.joints,
  p.stock, p.price_raw, p.img, p.url, p.part_type, p.pcba_type,
  p.category, p.subcategory, p.datasheet
`;


function buildFilterClause(params: SearchParams): { sql: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.partTypes.length > 0) {
    const placeholders = params.partTypes.map(() => "?").join(",");
    clauses.push(`p.part_type IN (${placeholders})`);
    values.push(...params.partTypes);
  }

  if (params.inStock) {
    clauses.push("p.stock > 0");
  }

  return {
    sql: clauses.length > 0 ? "AND " + clauses.join(" AND ") : "",
    values,
  };
}

function applyBoost(results: (PartSummary & { score?: number })[], q: string): PartSummary[] {
  const qLower = q.toLowerCase().trim();
  return results
    .map((r) => {
      let boost = r.score ?? 0;
      const lcscLower = r.lcsc.toLowerCase();
      const mpnLower = r.mpn.toLowerCase();
      if (lcscLower === qLower) boost -= 1000;
      else if (mpnLower === qLower) boost -= 800;
      else if (mpnLower.startsWith(qLower)) boost -= 400;
      else if (lcscLower.startsWith(qLower)) boost -= 300;
      if (r.part_type === "Basic") boost -= 50;
      else if (r.part_type === "Preferred") boost -= 25;
      const lcscNum = parseInt(r.lcsc.slice(1)) || 9999999;
      boost -= Math.max(0, 50 - Math.log10(lcscNum + 1) * 7);
      return { ...r, score: boost };
    })
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
}

function rowToSummary(row: Record<string, unknown>): PartSummary {
  return {
    lcsc: row.lcsc as string,
    mpn: row.mpn as string,
    manufacturer: row.manufacturer as string | null,
    description: row.description as string,
    package: row.package as string | null,
    joints: row.joints as number | null,
    stock: row.stock as number,
    price_raw: row.price_raw as string,
    img: row.img as string | null,
    url: row.url as string | null,
    part_type: row.part_type as string,
    pcba_type: row.pcba_type as string,
    category: row.category as string,
    subcategory: row.subcategory as string,
    datasheet: row.datasheet as string | null,
  };
}

/** Extract lowest unit price from price_raw string like "1-9:0.005,10-99:0.004,..." */
function parseUnitPrice(priceRaw: string): number {
  if (!priceRaw) return Infinity;
  const tiers = priceRaw.split(",");
  const first = tiers[0];
  if (!first) return Infinity;
  const colonIdx = first.indexOf(":");
  if (colonIdx < 0) return Infinity;
  const price = parseFloat(first.slice(colonIdx + 1));
  return isFinite(price) && price > 0 ? price : Infinity;
}

/** Get SQL ORDER BY clause for stock-based sorts, or null for relevance/price (app-layer) */
function getSqlOrderBy(sort: string): string | null {
  switch (sort) {
    case "stock_desc": return "p.stock DESC";
    case "stock_asc": return "p.stock ASC";
    default: return null; // relevance uses BM25 score, price needs app-layer sort
  }
}

function applySortToResults(
  results: (PartSummary & { score?: number })[],
  sort: string
): (PartSummary & { score?: number })[] {
  switch (sort) {
    case "price_asc":
      return [...results].sort((a, b) => parseUnitPrice(a.price_raw) - parseUnitPrice(b.price_raw));
    case "price_desc":
      return [...results].sort((a, b) => parseUnitPrice(b.price_raw) - parseUnitPrice(a.price_raw));
    case "stock_desc":
      return [...results].sort((a, b) => b.stock - a.stock);
    case "stock_asc":
      return [...results].sort((a, b) => a.stock - b.stock);
    default:
      return results;
  }
}

function buildAndGroupSql(group: RangeFilter[], values: unknown[]): string {
  if (group.length === 1) return singleFilterSql(group[0], values);
  return group.map((f) => singleFilterSql(f, values)).join("\nINTERSECT\n");
}

function singleFilterSql(f: RangeFilter, values: unknown[]): string {
  let condition: string;
  switch (f.op) {
    case "gt":    condition = "value > ?"; values.push(f.unit, f.value); break;
    case "gte":   condition = "value >= ?"; values.push(f.unit, f.value); break;
    case "lt":    condition = "value < ?"; values.push(f.unit, f.value); break;
    case "lte":   condition = "value <= ?"; values.push(f.unit, f.value); break;
    case "eq":    condition = "value = ?"; values.push(f.unit, f.value); break;
    case "between": condition = "value BETWEEN ? AND ?"; values.push(f.unit, f.min, f.max); break;
  }
  return `SELECT DISTINCT lcsc FROM part_nums WHERE unit = ? AND ${condition!}`;
}

function materializeRangeFilter(
  db: ReturnType<typeof getDb>,
  filterGroups: RangeFilter[][]
): string | null {
  if (filterGroups.length === 0) return null;

  const values: unknown[] = [];
  let sql: string;

  if (filterGroups.length === 1) {
    sql = buildAndGroupSql(filterGroups[0], values);
  } else {
    sql = filterGroups.map((g) => buildAndGroupSql(g, values)).join("\nUNION\n");
  }

  db.run("DROP TABLE IF EXISTS _range_filter");
  db.run(`CREATE TEMP TABLE _range_filter AS ${sql}`, values);
  db.run("CREATE INDEX IF NOT EXISTS _rf_idx ON _range_filter(lcsc)");

  return "_range_filter";
}

export function search(params: SearchParams): { results: PartSummary[]; total: number } {
  const db = getDb();
  const { q, limit, offset } = params;
  const trimmed = q.trim();

  if (trimmed.length === 0) {
    return { results: [], total: 0 };
  }

  const filter = buildFilterClause(params);
  const parsed = parseQuery(trimmed);
  const rfTable = materializeRangeFilter(db, parsed.filterGroups);
  const rfJoin = rfTable ? `JOIN ${rfTable} rf ON rf.lcsc = p.lcsc` : "";

  // For non-relevance sorts, we need to fetch more from FTS and re-sort
  const isRelevanceSort = params.sort === "relevance";
  const sqlStockOrder = getSqlOrderBy(params.sort);
  // For price sort, we fetch extra results and sort in app layer
  const isPriceSort = params.sort === "price_asc" || params.sort === "price_desc";
  const SORT_FETCH_MULTIPLIER = 10; // fetch 10x to get a good sort window

  try {
    // Path 1: Exact LCSC code lookup
    if (!rfTable && detectLcscCode(parsed.text || trimmed)) {
      const code = (parsed.text || trimmed).toUpperCase();
      const row = db.query<Record<string, unknown>, unknown[]>(
        `SELECT ${SELECT_COLS} FROM parts p ${rfJoin} WHERE p.lcsc = ? ${filter.sql} LIMIT 1`
      ).get(code, ...filter.values);

      if (row) return { results: [rowToSummary(row)], total: 1 };
    }

    // Path 0: Range-only query (no text tokens)
    if (!parsed.text && rfTable) {
      const orderBy = sqlStockOrder ?? "p.stock DESC";
      const fetchLimit = isPriceSort ? limit * SORT_FETCH_MULTIPLIER : limit + 1;
      const sqlOffset = isPriceSort ? 0 : offset;
      const rows = db.query<Record<string, unknown>, unknown[]>(`
        SELECT ${SELECT_COLS}
        FROM parts p
        ${rfJoin}
        WHERE 1=1
        ${filter.sql}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...filter.values, fetchLimit, sqlOffset);

      let results = rows.map((r) => ({ ...rowToSummary(r), score: 0 }));

      if (isPriceSort) {
        results = applySortToResults(results, params.sort);
        const total = rows.length >= fetchLimit ? fetchLimit + 1 : rows.length;
        return { results: results.slice(offset, offset + limit), total };
      }

      const hasMore = rows.length > limit;
      const resultRows = hasMore ? rows.slice(0, limit) : rows;
      results = resultRows.map((r) => ({ ...rowToSummary(r), score: 0 }));
      const total = hasMore ? offset + limit + 1 : offset + resultRows.length;
      return { results, total };
    }

    // Path 2: FTS5 BM25 search (with optional range filters)
    const textQuery = parsed.text || trimmed;
    const ftsAndQuery = buildFtsQuery(textQuery);
    const ftsOrQuery = buildFtsOrQuery(textQuery);

    let ftsResults: (PartSummary & { score?: number })[] = [];
    let total = 0;

    const runFts = (matchQuery: string, fetchLimit = limit): { rows: Record<string, unknown>[]; cnt: number } => {
      try {
        // For stock sorts, use SQL ORDER BY directly
        // For relevance, use BM25 score
        // For price, fetch by BM25 then re-sort in app layer
        const orderBy = sqlStockOrder ?? "bm25(parts_fts, 10, 8, 3, 5, 2, 4, 3) ASC";

        const rows = db.query<Record<string, unknown>, unknown[]>(`
          SELECT ${SELECT_COLS},
            bm25(parts_fts, 10, 8, 3, 5, 2, 4, 3) AS score
          FROM parts_fts
          JOIN parts p ON p.rowid = parts_fts.rowid
          ${rfJoin}
          WHERE parts_fts MATCH ?
          ${filter.sql}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?
        `).all(matchQuery, ...filter.values, fetchLimit, isPriceSort ? 0 : offset);

        // Skip expensive COUNT when range filters — estimate from results
        if (rfTable) {
          const cnt = rows.length < fetchLimit ? rows.length : fetchLimit + 1;
          return { rows, cnt };
        }

        const countRow = db.query<{ cnt: number }, unknown[]>(`
          SELECT COUNT(*) AS cnt
          FROM parts_fts
          JOIN parts p ON p.rowid = parts_fts.rowid
          ${rfJoin}
          WHERE parts_fts MATCH ?
          ${filter.sql}
        `).get(matchQuery, ...filter.values);

        return { rows, cnt: countRow?.cnt ?? 0 };
      } catch {
        return { rows: [], cnt: 0 };
      }
    };

    // Determine fetch limit based on sort mode
    const baseFetchLimit = isPriceSort ? limit * SORT_FETCH_MULTIPLIER : limit;

    // Try strict AND first
    let { rows, cnt } = runFts(ftsAndQuery, baseFetchLimit);

    // If AND returns no results and strict mode is off, use fallbacks
    const FALLBACK_FETCH = Math.max(300, baseFetchLimit * 3);
    if (cnt === 0 && textQuery.includes(" ") && !params.matchAll) {
      const tokens = textQuery.split(/\s+/).filter(Boolean);

      if (tokens.length >= 2) {
        const tokMatchCounts = tokens.map((tok) => {
          const tq = `"${tok.replace(/"/g, '""')}"*`;
          try { return { tok, cnt: db.query<{ cnt: number }, unknown[]>(`SELECT COUNT(*) AS cnt FROM parts_fts WHERE parts_fts MATCH ?`).get(tq)?.cnt ?? 0 }; }
          catch { return { tok, cnt: 0 }; }
        });
        const matchingTokens = tokMatchCounts.filter((t) => t.cnt > 0).map((t) => t.tok);

        if (matchingTokens.length >= 2 && matchingTokens.length < tokens.length) {
          const result = runFts(buildFtsQuery(matchingTokens.join(" ")), FALLBACK_FETCH);
          if (result.cnt > 0) { rows = result.rows; cnt = result.cnt; }
        }

        if (cnt === 0) {
          const tryTokens = matchingTokens.length >= 2 ? matchingTokens : tokens;
          const sortedByLength = [...tryTokens].sort((a, b) => b.length - a.length);
          const kept = new Set(tryTokens);

          for (const dropTok of sortedByLength) {
            if (kept.size < 2) break;
            kept.delete(dropTok);
            const remaining = tryTokens.filter((t) => kept.has(t));
            const result = runFts(buildFtsQuery(remaining.join(" ")), FALLBACK_FETCH);
            if (result.cnt > 0) { rows = result.rows; cnt = result.cnt; break; }
          }
        }
      }

      if (cnt === 0) {
        const orResult = runFts(ftsOrQuery, baseFetchLimit);
        rows = orResult.rows;
        cnt = orResult.cnt;
      }
    }

    total = cnt;
    ftsResults = rows.map((r) => ({ ...rowToSummary(r), score: r.score as number }));

    if (isRelevanceSort) {
      ftsResults = applyBoost(ftsResults, textQuery);
    } else if (isPriceSort) {
      ftsResults = applySortToResults(ftsResults, params.sort);
      // Slice to the requested page from the sorted larger set
      ftsResults = ftsResults.slice(offset, offset + limit);
    }
    // Stock sorts are already ordered by SQL

    // Path 3: Fuzzy LIKE fallback
    if (params.fuzzy && ftsResults.length < 5 && !params.matchAll) {
      const tokens = textQuery.split(/\s+/).filter(Boolean);
      if (tokens.length > 0) {
        const likeClauses = tokens
          .map(() => "(p.description LIKE ? OR p.mpn LIKE ? OR p.lcsc LIKE ?)")
          .join(" AND ");
        const likeValues = tokens.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);

        const fuzzyRows = db.query<Record<string, unknown>, unknown[]>(`
          SELECT ${SELECT_COLS}
          FROM parts p
          ${rfJoin}
          WHERE ${likeClauses}
          ${filter.sql}
          LIMIT ?
        `).all(...likeValues, ...filter.values, limit);

        const fuzzyResults = fuzzyRows.map(rowToSummary);
        const seen = new Set(ftsResults.map((r) => r.lcsc));
        for (const r of fuzzyResults) {
          if (!seen.has(r.lcsc)) {
            ftsResults.push(r);
            seen.add(r.lcsc);
          }
        }
        total = Math.max(total, ftsResults.length);
      }
    }

    return { results: ftsResults.slice(0, limit), total };
  } finally {
    if (rfTable) {
      try { db.run(`DROP TABLE IF EXISTS ${rfTable}`); } catch {}
    }
  }
}
