import { getSql } from "../db.ts";
import {
  buildTsQuery, buildNegationTsQuery,
  detectLcscCode, parseQuery, type RangeFilter,
} from "./parser.ts";
import type { PartSummary, SearchParams } from "../types.ts";

const SELECT_COLS = `
  p.lcsc, p.mpn, p.manufacturer, p.description, p.package, p.joints,
  p.stock, p.price_raw, p.img, p.url, p.part_type, p.pcba_type,
  p.category, p.subcategory, p.datasheet
`;

const TS_WEIGHTS = "{0.1, 0.2, 0.4, 1.0}"; // D, C, B, A

function applyBoost(results: (PartSummary & { score: number })[], q: string): (PartSummary & { score: number })[] {
  const qLower = q.toLowerCase().trim();
  return results
    .map((r) => {
      let boost = r.score;
      const lcscLower = r.lcsc.toLowerCase();
      const mpnLower = r.mpn.toLowerCase();
      if (lcscLower === qLower) boost += 1000;
      else if (mpnLower === qLower) boost += 800;
      else if (mpnLower.startsWith(qLower)) boost += 400;
      else if (lcscLower.startsWith(qLower)) boost += 300;
      if (r.part_type === "Basic") boost += 50;
      else if (r.part_type === "Preferred") boost += 25;
      const lcscNum = parseInt(r.lcsc.slice(1)) || 9999999;
      boost += Math.max(0, 50 - Math.log10(lcscNum + 1) * 7);
      return { ...r, score: boost };
    })
    .sort((a, b) => b.score - a.score); // higher = better
}

function parseUnitPrice(priceRaw: string): number {
  if (!priceRaw) return Infinity;
  const first = priceRaw.split(",")[0];
  if (!first) return Infinity;
  const colonIdx = first.indexOf(":");
  if (colonIdx < 0) return Infinity;
  const price = parseFloat(first.slice(colonIdx + 1));
  return isFinite(price) && price > 0 ? price : Infinity;
}

function applySortToResults(
  results: (PartSummary & { score: number })[],
  sort: string,
): (PartSummary & { score: number })[] {
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

// ── Dynamic SQL fragment builders ────────────────────────────────────

function buildRangeExistsFragment(sql: ReturnType<typeof getSql>, f: RangeFilter) {
  switch (f.op) {
    case "gt":      return sql`EXISTS (SELECT 1 FROM part_nums pn WHERE pn.lcsc = p.lcsc AND pn.unit = ${f.unit} AND pn.value > ${f.value})`;
    case "gte":     return sql`EXISTS (SELECT 1 FROM part_nums pn WHERE pn.lcsc = p.lcsc AND pn.unit = ${f.unit} AND pn.value >= ${f.value})`;
    case "lt":      return sql`EXISTS (SELECT 1 FROM part_nums pn WHERE pn.lcsc = p.lcsc AND pn.unit = ${f.unit} AND pn.value < ${f.value})`;
    case "lte":     return sql`EXISTS (SELECT 1 FROM part_nums pn WHERE pn.lcsc = p.lcsc AND pn.unit = ${f.unit} AND pn.value <= ${f.value})`;
    case "eq":      return sql`EXISTS (SELECT 1 FROM part_nums pn WHERE pn.lcsc = p.lcsc AND pn.unit = ${f.unit} AND pn.value = ${f.value})`;
    case "between": return sql`EXISTS (SELECT 1 FROM part_nums pn WHERE pn.lcsc = p.lcsc AND pn.unit = ${f.unit} AND pn.value BETWEEN ${f.min} AND ${f.max})`;
  }
}

function buildColumnFilter(sql: ReturnType<typeof getSql>, filterGroups: RangeFilter[][]) {
  const pads: RangeFilter[] = [];
  for (const g of filterGroups) for (const f of g) if (f.unit === "_pads") pads.push(f);
  if (pads.length === 0) return sql``;
  const parts = pads.map((f) => {
    switch (f.op) {
      case "gt":      return sql`p.joints > ${f.value}`;
      case "gte":     return sql`p.joints >= ${f.value}`;
      case "lt":      return sql`p.joints < ${f.value}`;
      case "lte":     return sql`p.joints <= ${f.value}`;
      case "eq":      return sql`p.joints = ${f.value}`;
      case "between": return sql`p.joints BETWEEN ${f.min} AND ${f.max}`;
    }
  });
  return parts.reduce((a, b) => sql`${a} AND ${b}`);
}

function stripColumnFilters(filterGroups: RangeFilter[][]): RangeFilter[][] {
  return filterGroups.map((g) => g.filter((f) => f.unit !== "_pads")).filter((g) => g.length > 0);
}

function buildRangeFilter(sql: ReturnType<typeof getSql>, filterGroups: RangeFilter[][]) {
  if (filterGroups.length === 0) return sql``;
  const orParts = filterGroups.map((group) => {
    const andParts = group.map((f) => buildRangeExistsFragment(sql, f));
    return andParts.reduce((a, b) => sql`${a} AND ${b}`);
  });
  if (orParts.length === 1) return orParts[0];
  return orParts.reduce((a, b) => sql`(${a}) OR (${b})`);
}

// ── Main search function ─────────────────────────────────────────────

export async function search(params: SearchParams): Promise<{ results: PartSummary[]; total: number }> {
  const sql = getSql();
  const { q, limit, offset } = params;
  const trimmed = q.trim();

  if (trimmed.length === 0) return { results: [], total: 0 };

  const parsed = parseQuery(trimmed);
  const hasTextContent = parsed.text || parsed.phrases.length > 0;
  const numericGroups = stripColumnFilters(parsed.filterGroups);
  const hasRangeFilter = numericGroups.length > 0;
  const colFilterFrag = buildColumnFilter(sql, parsed.filterGroups);
  const hasColFilter = parsed.filterGroups.some((g) => g.some((f) => f.unit === "_pads"));
  const hasAnyFilter = hasRangeFilter || hasColFilter;

  // Build shared filter fragments
  const typeFilter = params.partTypes.length > 0
    ? sql`AND p.part_type IN ${sql(params.partTypes)}`
    : sql``;
  const stockFilter = params.inStock ? sql`AND p.stock > 0` : sql``;
  const colFilter = hasColFilter ? sql`AND ${colFilterFrag}` : sql``;
  const rangeFilter = hasRangeFilter ? sql`AND ${buildRangeFilter(sql, numericGroups)}` : sql``;
  const negQuery = buildNegationTsQuery(parsed.negations);
  const negFilter = negQuery
    ? sql`AND NOT p.search_vec @@ to_tsquery('simple', ${negQuery})`
    : sql``;

  const isRelevanceSort = params.sort === "relevance";
  const isPriceSort = params.sort === "price_asc" || params.sort === "price_desc";
  const RERANK_LIMIT = 300;

  // Path 1: Exact LCSC lookup
  if (!hasAnyFilter && !parsed.phrases.length && !parsed.negations.length && detectLcscCode(parsed.text || trimmed)) {
    const code = (parsed.text || trimmed).toUpperCase();
    const rows = await sql.unsafe(
      `SELECT ${SELECT_COLS} FROM parts p WHERE p.lcsc = $1 LIMIT 1`,
      [code],
    );
    if (rows.length > 0) {
      return { results: [rows[0] as unknown as PartSummary], total: 1 };
    }
  }

  // Path 0: Filter-only (no text, has range/column filters)
  if (!hasTextContent && hasAnyFilter) {
    const orderFrag = params.sort === "stock_asc" ? sql`p.stock ASC`
      : params.sort === "stock_desc" ? sql`p.stock DESC`
      : sql`p.stock DESC`;
    const fetchLimit = isPriceSort ? limit * 10 : limit + 1;
    const sqlOffset = isPriceSort ? 0 : offset;

    const rows = await sql`
      SELECT ${sql.unsafe(SELECT_COLS)}
      FROM parts p
      WHERE TRUE
      ${rangeFilter} ${colFilter} ${typeFilter} ${stockFilter} ${negFilter}
      ORDER BY ${orderFrag}
      LIMIT ${fetchLimit} OFFSET ${sqlOffset}
    `;

    let results = rows.map((r) => ({ ...(r as unknown as PartSummary), score: 0 }));

    if (isPriceSort) {
      results = applySortToResults(results, params.sort);
      const total = rows.length >= fetchLimit ? fetchLimit + 1 : rows.length;
      return { results: results.slice(offset, offset + limit), total };
    }

    const hasMore = rows.length > limit;
    const total = hasMore ? offset + limit + 1 : offset + rows.length;
    return { results: results.slice(0, limit), total };
  }

  if (!hasTextContent) return { results: [], total: 0 };

  // Path 2: Full-text search
  const textQuery = parsed.text;
  const andQ = buildTsQuery(textQuery, parsed.phrases);

  if (!andQ) return { results: [], total: 0 };

  const isMultiToken = !params.matchAll && textQuery.includes(" ");

  // Build ORDER BY based on sort mode
  const orderByRank = params.sort === "stock_asc" ? sql`p.stock ASC`
    : params.sort === "stock_desc" ? sql`p.stock DESC`
    : sql`rank DESC`;

  let fetchLimit: number;
  let fetchOffset: number;

  if (isRelevanceSort) {
    fetchLimit = Math.max(RERANK_LIMIT, offset + limit);
    fetchOffset = 0;
  } else if (isPriceSort) {
    fetchLimit = limit * 10;
    fetchOffset = 0;
  } else {
    fetchLimit = limit + 1; // +1 to detect hasMore
    fetchOffset = offset;
  }

  try {
    let rows: Record<string, unknown>[];
    let total: number;

    // Always try AND query first — it's fast and precise
    const andRows = await sql`
      SELECT ${sql.unsafe(SELECT_COLS)},
        ts_rank_cd(${sql.unsafe(`'${TS_WEIGHTS}'`)}, p.search_vec, to_tsquery('simple', ${andQ})) AS rank
      FROM parts p
      WHERE p.search_vec @@ to_tsquery('simple', ${andQ})
      ${rangeFilter} ${colFilter} ${typeFilter} ${stockFilter} ${negFilter}
      ORDER BY ${orderByRank}
      LIMIT ${fetchLimit} OFFSET ${fetchOffset}
    `;

    if (!isMultiToken || andRows.length >= fetchLimit) {
      // AND query has enough results — use it directly
      rows = andRows;
      // Estimate total using sentinel: if we filled fetchLimit, signal "there are more"
      if (rows.length >= fetchLimit) {
        total = fetchOffset + fetchLimit + 1;
      } else {
        total = fetchOffset + rows.length;
      }
    } else {
      // AND returned few results — supplement with N-1 token AND queries
      // This is much faster than OR-all which scans huge result sets
      const tokens = textQuery.trim().split(/\s+/).filter(Boolean);
      const andSeen = new Set(andRows.map((r) => r.lcsc as string));
      const tier1Rows: Record<string, unknown>[] = [];
      const needed = fetchLimit - andRows.length;

      if (tokens.length >= 2 && needed > 0) {
        // Drop one token at a time, longest first (most specific) — keeps
        // shorter/common tokens that narrow results, better perf.
        // Cap at 3 sub-queries to bound total work.
        const sorted = [...tokens].sort((a, b) => b.length - a.length);
        for (const drop of sorted.slice(0, 3)) {
          if (tier1Rows.length >= needed) break;
          const remaining = tokens.filter((t) => t !== drop);
          const subQ = buildTsQuery(remaining.join(" "), parsed.phrases);
          if (!subQ || subQ === andQ) continue;
          // Tier-1 (demoted) results: order by stock instead of rank
          // to avoid expensive ts_rank_cd on broad result sets
          const subRows = await sql`
            SELECT ${sql.unsafe(SELECT_COLS)},
              0 AS rank
            FROM parts p
            WHERE p.search_vec @@ to_tsquery('simple', ${subQ})
              AND NOT p.search_vec @@ to_tsquery('simple', ${andQ})
            ${rangeFilter} ${colFilter} ${typeFilter} ${stockFilter} ${negFilter}
            ORDER BY p.stock DESC
            LIMIT ${needed - tier1Rows.length}
          `;
          for (const r of subRows) {
            if (!andSeen.has(r.lcsc as string)) {
              tier1Rows.push(r);
              andSeen.add(r.lcsc as string);
            }
          }
        }
      }

      const andWithTier = andRows.map((r) => ({ ...r, tier: 0 }));
      const orWithTier = tier1Rows.map((r) => ({ ...r, tier: 1 }));
      rows = [...andWithTier, ...orWithTier];
      total = rows.length;
    }

    // Map to summaries
    let results: (PartSummary & { score: number })[] = rows.map((r) => ({
      ...(r as unknown as PartSummary),
      score: Number((r as Record<string, unknown>).rank ?? 0)
        + ((r as Record<string, unknown>).tier === 0 ? 1000 : 0),
    }));

    if (isRelevanceSort) {
      results = applyBoost(results, textQuery).slice(offset, offset + limit);
    } else if (isPriceSort) {
      results = applySortToResults(results, params.sort).slice(offset, offset + limit);
    } else {
      // Trim the +1 we added for hasMore detection
      const hasMore = results.length > limit;
      if (hasMore) total = Math.max(total, offset + limit + 1);
      results = results.slice(0, limit);
    }

    // Path 3: Fuzzy fallback with trigram similarity
    if (params.fuzzy && results.length < 5 && !params.matchAll) {
      const tokens = textQuery.split(/\s+/).filter(Boolean);
      if (tokens.length > 0) {
        const pattern = `%${tokens.join("%")}%`;
        const seen = new Set(results.map((r) => r.lcsc));

        // First: mpn ILIKE (uses idx_parts_mpn_trgm, fast ~1ms)
        const fuzzyMpnRows = await sql`
          SELECT ${sql.unsafe(SELECT_COLS)}
          FROM parts p
          WHERE p.mpn ILIKE ${pattern}
          ${rangeFilter} ${colFilter} ${typeFilter} ${stockFilter} ${negFilter}
          LIMIT ${limit}
        `;
        for (const r of fuzzyMpnRows) {
          if (!seen.has(r.lcsc as string)) {
            results.push({ ...(r as unknown as PartSummary), score: 0 });
            seen.add(r.lcsc as string);
          }
        }

        // Only if still need more: description ILIKE (slower, no trgm index)
        if (results.length < 5) {
          const excludeLcscs = [...seen];
          const fuzzyDescRows = await sql`
            SELECT ${sql.unsafe(SELECT_COLS)}
            FROM parts p
            WHERE p.description ILIKE ${pattern}
              AND p.lcsc != ALL(${excludeLcscs})
            ${rangeFilter} ${colFilter} ${typeFilter} ${stockFilter} ${negFilter}
            LIMIT ${limit}
          `;
          for (const r of fuzzyDescRows) {
            if (!seen.has(r.lcsc as string)) {
              results.push({ ...(r as unknown as PartSummary), score: 0 });
              seen.add(r.lcsc as string);
            }
          }
        }

        total = Math.max(total, results.length);
      }
    }

    return { results: results.slice(0, limit), total };
  } catch (err) {
    console.error("Search error:", err);
    return { results: [], total: 0 };
  }
}
