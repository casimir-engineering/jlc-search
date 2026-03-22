import { getSql } from "../db.ts";
import {
  buildTsQuery, buildTsOrQuery, buildNegationTsQuery,
  detectLcscCode, parseQuery, type RangeFilter,
} from "./parser.ts";
import type { PartSummary, SearchParams } from "../types.ts";

const SELECT_COLS = `
  p.lcsc, p.mpn, p.manufacturer, p.description, p.package, p.joints,
  p.stock, p.jlc_stock, p.price_raw, p.img, p.url, p.part_type, p.pcba_type,
  p.category, p.subcategory, p.datasheet, p.moq
`;

function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

function applyBoost(results: (PartSummary & { score: number })[], q: string): (PartSummary & { score: number })[] {
  const qLower = q.toLowerCase().trim();
  const qTokens = qLower.split(/\s+/).filter(Boolean);
  return results
    .map((r) => {
      let boost = r.score;
      const lcscLower = r.lcsc.toLowerCase();
      const mpnLower = r.mpn.toLowerCase();
      if (lcscLower === qLower) boost += 1000;
      else if (mpnLower === qLower) boost += 800;
      else if (mpnLower.startsWith(qLower)) boost += 400;
      else if (lcscLower.startsWith(qLower)) boost += 300;
      // Field-match boost: reward matching more tokens, big bonus for all-match
      if (qTokens.length > 1) {
        const descLower = (r.description || "").toLowerCase();
        const fullLower = `${mpnLower} ${descLower} ${(r.manufacturer || "").toLowerCase()} ${(r.package || "").toLowerCase()}`;
        let matched = 0;
        for (const tok of qTokens) {
          if (fullLower.includes(tok)) {
            matched++;
            if (mpnLower.includes(tok)) boost += 50;
            else boost += 20;
          }
        }
        // Big bonus for matching ALL tokens (full match >> partial match)
        if (matched === qTokens.length) boost += 500;
        else if (matched >= qTokens.length - 1) boost += 200;
      }
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
    case "gte":     return sql`EXISTS (SELECT 1 FROM part_nums pn WHERE pn.lcsc = p.lcsc AND pn.unit = ${f.unit} AND pn.value >= ${f.value})`;
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
      case "gte":     return sql`p.joints >= ${f.value}`;
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
  const categoryFilter = params.categories.length > 0
    ? sql`AND p.category IN ${sql(params.categories)}`
    : sql``;
  const economicFilter = params.economic
    ? sql`AND p.pcba_type LIKE '%Economic%'`
    : sql``;
  const stockFilter = (() => {
    switch (params.stockFilter) {
      case "lcsc": return sql`AND p.stock > 0`;
      case "jlc": return sql`AND p.jlc_stock > 0`;
      case "any": return sql`AND (p.stock > 0 OR p.jlc_stock > 0)`;
      default: return sql``;
    }
  })();
  const colFilter = hasColFilter ? sql`AND ${colFilterFrag}` : sql``;
  const rangeFilter = hasRangeFilter ? sql`AND ${buildRangeFilter(sql, numericGroups)}` : sql``;
  const negQuery = buildNegationTsQuery(parsed.negations);
  const negFilter = negQuery
    ? sql`AND NOT p.search_vec @@ to_tsquery('simple', ${negQuery})`
    : sql``;

  const isRelevanceSort = params.sort === "relevance";
  const isPriceSort = params.sort === "price_asc" || params.sort === "price_desc";

  // Path 1: Exact LCSC lookup
  if (!hasAnyFilter && !parsed.phrases.length && !parsed.negations.length && detectLcscCode(parsed.text || trimmed)) {
    const code = (parsed.text || trimmed).toUpperCase();
    const rows = await sql`
      SELECT ${sql.unsafe(SELECT_COLS)}
      FROM parts p
      WHERE p.lcsc = ${code}
      ${typeFilter} ${categoryFilter} ${economicFilter} ${stockFilter}
      LIMIT 1
    `;
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
      ${rangeFilter} ${colFilter} ${typeFilter} ${categoryFilter} ${economicFilter} ${stockFilter} ${negFilter}
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

  // Path 2: Tiered full-text search
  const textQuery = parsed.text;
  const andQ = buildTsQuery(textQuery, parsed.phrases);

  if (!andQ) return { results: [], total: 0 };

  const isMultiToken = !params.matchAll && textQuery.includes(" ");
  const orQ = isMultiToken ? (buildTsOrQuery(textQuery, parsed.phrases) || andQ) : null;

  // Tier limits: how many rows each tier fetches for ranking.
  // Total displayed = deduped union of all tiers, paginated by offset/limit.
  const TIER0_LIMIT = 500;
  const TIER1_LIMIT = 500;

  try {
    // ── Tier 0: FTS AND match (all tokens must match — highest quality) ──
    const tier0Rows = await sql`
      SELECT ${sql.unsafe(SELECT_COLS)}
      FROM parts p
      WHERE p.search_vec @@ to_tsquery('simple', ${andQ})
      ${rangeFilter} ${colFilter} ${typeFilter} ${categoryFilter} ${economicFilter} ${stockFilter} ${negFilter}
      ORDER BY p.stock DESC
      LIMIT ${TIER0_LIMIT}
    `;

    // ── Tier 0.5: OR fallback (partial token matches, lower score) ──
    const tier05Rows: Record<string, unknown>[] = [];
    const tokens = textQuery.trim().split(/\s+/).filter(Boolean);

    if (orQ && tier0Rows.length < TIER0_LIMIT) {
      const t0Lcscs = tier0Rows.map((r) => r.lcsc as string);
      const t0Exclude = t0Lcscs.length > 0 ? sql`AND p.lcsc != ALL(${t0Lcscs})` : sql``;
      const t05Limit = TIER0_LIMIT - tier0Rows.length;
      const t05Rows = await sql`
        SELECT ${sql.unsafe(SELECT_COLS)}
        FROM parts p
        WHERE p.search_vec @@ to_tsquery('simple', ${orQ})
        ${t0Exclude}
        ${rangeFilter} ${colFilter} ${typeFilter} ${categoryFilter} ${economicFilter} ${stockFilter} ${negFilter}
        ORDER BY p.stock DESC
        LIMIT ${t05Limit}
      `;
      tier05Rows.push(...t05Rows);
    }

    // ── Tier 1: Substring ILIKE (trigram indexes on mpn, manufacturer, full_text) ──
    // Build ILIKE patterns from text tokens and phrases
    // Skip tokens < 3 chars — trigram index needs at least 3 chars for efficient lookup
    const ilikeTokens: string[] = [];
    for (const tok of tokens) {
      const escaped = escapeIlike(tok.toLowerCase());
      if (escaped && escaped.length >= 3) ilikeTokens.push(`%${escaped}%`);
    }
    for (const phrase of parsed.phrases) {
      const escaped = escapeIlike(phrase.toLowerCase());
      if (escaped) ilikeTokens.push(`%${escaped}%`);
    }

    const tier1aRows: Record<string, unknown>[] = []; // manufacturer matches (high value)
    const tier1bRows: Record<string, unknown>[] = []; // full_text matches (broad)

    if (ilikeTokens.length > 0) {
      const excludeLcscs = [
        ...tier0Rows.map((r) => r.lcsc as string),
        ...tier05Rows.map((r) => r.lcsc as string),
      ];
      const excludeFilter = excludeLcscs.length > 0
        ? sql`AND p.lcsc != ALL(${excludeLcscs})`
        : sql``;

      // Build negation fragment for ILIKE tier
      let negFrag = sql``;
      for (const neg of parsed.negations) {
        const escaped = escapeIlike(neg.toLowerCase());
        if (escaped) negFrag = sql`${negFrag} AND p.full_text NOT ILIKE ${`%${escaped}%`}`;
      }

      const seen = new Set(excludeLcscs);
      const T1_MFR_LIMIT = 50; // Reserve slots for manufacturer matches

      // Tier 1a: Manufacturer substring — most specific, catches "ada" → Padauk
      {
        let mfrWhere = sql`p.manufacturer ILIKE ${ilikeTokens[0]}`;
        for (let i = 1; i < ilikeTokens.length; i++) {
          mfrWhere = isMultiToken
            ? sql`${mfrWhere} OR p.manufacturer ILIKE ${ilikeTokens[i]}`
            : sql`${mfrWhere} AND p.manufacturer ILIKE ${ilikeTokens[i]}`;
        }
        const t1aRows = await sql`
          SELECT ${sql.unsafe(SELECT_COLS)}
          FROM parts p
          WHERE (${mfrWhere})
          ${excludeFilter} ${negFrag}
          ${rangeFilter} ${colFilter} ${typeFilter} ${categoryFilter} ${economicFilter} ${stockFilter}
          LIMIT ${T1_MFR_LIMIT}
        `;
        for (const r of t1aRows) {
          if (!seen.has(r.lcsc as string)) {
            tier1aRows.push(r as Record<string, unknown>);
            seen.add(r.lcsc as string);
          }
        }
      }

      // Tier 1b: MPN + full_text substring — skip if Tier 0 already saturated (saves 30-180ms)
      if (tier0Rows.length < TIER0_LIMIT && tier1aRows.length + tier1bRows.length < TIER1_LIMIT) {
        const allExclude = [...seen];
        const allExcludeFilter = allExclude.length > 0
          ? sql`AND p.lcsc != ALL(${allExclude})`
          : sql``;
        let ftWhere = sql`p.full_text ILIKE ${ilikeTokens[0]}`;
        for (let i = 1; i < ilikeTokens.length; i++) {
          ftWhere = isMultiToken
            ? sql`${ftWhere} OR p.full_text ILIKE ${ilikeTokens[i]}`
            : sql`${ftWhere} AND p.full_text ILIKE ${ilikeTokens[i]}`;
        }
        const remaining = TIER1_LIMIT - tier1aRows.length - tier1bRows.length;
        const t1bRows = await sql`
          SELECT ${sql.unsafe(SELECT_COLS)}
          FROM parts p
          WHERE (${ftWhere})
          ${allExcludeFilter} ${negFrag}
          ${rangeFilter} ${colFilter} ${typeFilter} ${categoryFilter} ${economicFilter} ${stockFilter}
          LIMIT ${remaining}
        `;
        for (const r of t1bRows) {
          if (!seen.has(r.lcsc as string)) {
            tier1bRows.push(r as Record<string, unknown>);
            seen.add(r.lcsc as string);
          }
        }
      }
    }

    // ── Merge and score ──────────────────────────────────────────
    let results: (PartSummary & { score: number })[] = [
      ...tier0Rows.map((r) => ({
        ...(r as unknown as PartSummary),
        score: 2000,
      })),
      ...tier05Rows.map((r) => ({
        ...(r as unknown as PartSummary),
        score: 1500,
      })),
      ...tier1aRows.map((r) => ({
        ...(r as unknown as PartSummary),
        score: 700, // manufacturer match — higher than broad substring
      })),
      ...tier1bRows.map((r) => ({
        ...(r as unknown as PartSummary),
        score: 400, // broad full_text substring
      })),
    ];

    // Fast total estimate using EXPLAIN (avoids slow COUNT(*) on broad queries)
    // Use OR query for estimate if available (broader match = better total), else AND
    const estimateQ = orQ ?? andQ;
    let totalCount = results.length;
    try {
      const explainRows = await sql`
        EXPLAIN (FORMAT JSON) SELECT 1 FROM parts p
        WHERE p.search_vec @@ to_tsquery('simple', ${estimateQ})
        ${rangeFilter} ${colFilter} ${typeFilter} ${categoryFilter} ${economicFilter} ${stockFilter} ${negFilter}
      `;
      const plan = (explainRows[0] as any)?.["QUERY PLAN"]?.[0]?.Plan;
      if (plan?.["Plan Rows"]) {
        totalCount = Math.max(Math.round(plan["Plan Rows"]), results.length);
      }
    } catch { /* fallback to results.length */ }

    // Cap total to actual results if tiers found fewer than a full page
    // (EXPLAIN estimate can be wildly off for prefix queries like "esp32s3:*")
    if (results.length < TIER0_LIMIT + TIER1_LIMIT && results.length < totalCount) {
      totalCount = results.length;
    }

    // Deep pagination: if offset is beyond what tiers fetched, use SQL-level pagination
    if (offset >= results.length && results.length >= TIER0_LIMIT) {
      const orderFrag = params.sort === "price_asc" || params.sort === "price_desc"
        ? sql`p.stock DESC` // price sort done in-app after fetch
        : params.sort === "stock_asc" ? sql`p.stock ASC`
        : sql`p.stock DESC`;
      const deepRows = await sql`
        SELECT ${sql.unsafe(SELECT_COLS)}
        FROM parts p
        WHERE p.search_vec @@ to_tsquery('simple', ${andQ})
        ${rangeFilter} ${colFilter} ${typeFilter} ${categoryFilter} ${economicFilter} ${stockFilter} ${negFilter}
        ORDER BY ${orderFrag}
        LIMIT ${limit} OFFSET ${offset}
      `;
      let deepResults = deepRows.map((r) => ({ ...(r as unknown as PartSummary), score: 0 }));
      if (isPriceSort) {
        deepResults = applySortToResults(deepResults, params.sort);
      }
      return { results: deepResults.slice(0, limit), total: totalCount };
    }

    if (isRelevanceSort) {
      results = applyBoost(results, textQuery).slice(offset, offset + limit);
    } else if (isPriceSort) {
      results = applySortToResults(results, params.sort).slice(offset, offset + limit);
    } else {
      if (params.sort === "stock_asc") {
        results = [...results].sort((a, b) => a.stock - b.stock);
      } else {
        results = [...results].sort((a, b) => b.stock - a.stock);
      }
      results = results.slice(offset, offset + limit);
    }

    return { results: results.slice(0, limit), total: totalCount };
  } catch (err) {
    console.error("Search error:", err);
    return { results: [], total: 0 };
  }
}
