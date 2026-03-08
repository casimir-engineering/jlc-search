import { getDb } from "../db.ts";
import { buildFtsQuery, buildFtsOrQuery, detectLcscCode } from "./parser.ts";
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
      // Prefer Basic > Preferred > Extended
      if (r.part_type === "Basic") boost -= 50;
      else if (r.part_type === "Preferred") boost -= 25;
      // Boost older/canonical parts: lower LCSC codes = more established parts
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

export function search(params: SearchParams): { results: PartSummary[]; total: number } {
  const db = getDb();
  const { q, limit, offset } = params;
  const trimmed = q.trim();

  if (trimmed.length === 0) {
    return { results: [], total: 0 };
  }

  const filter = buildFilterClause(params);

  // Path 1: Exact LCSC code lookup
  if (detectLcscCode(trimmed)) {
    const row = db.query<Record<string, unknown>, unknown[]>(
      `SELECT ${SELECT_COLS} FROM parts p WHERE p.lcsc = ? ${filter.sql} LIMIT 1`
    ).get(trimmed.toUpperCase(), ...filter.values);

    if (row) return { results: [rowToSummary(row)], total: 1 };
    // Fall through to FTS if not found (e.g. wrong case or partial)
  }

  // Path 2: FTS5 BM25 search
  // Try AND query first (all tokens must match), fall back to OR if no results
  const ftsAndQuery = buildFtsQuery(trimmed);
  const ftsOrQuery = buildFtsOrQuery(trimmed);

  let ftsResults: (PartSummary & { score?: number })[] = [];
  let total = 0;

  const runFts = (matchQuery: string, fetchLimit = limit): { rows: Record<string, unknown>[]; cnt: number } => {
    try {
      // Field weights: lcsc=10, mpn=8, manufacturer=3, description=5, package=2, subcategory=4
      const rows = db.query<Record<string, unknown>, unknown[]>(`
        SELECT ${SELECT_COLS},
          bm25(parts_fts, 10, 8, 3, 5, 2, 4) AS score
        FROM parts_fts
        JOIN parts p ON p.rowid = parts_fts.rowid
        WHERE parts_fts MATCH ?
        ${filter.sql}
        ORDER BY score ASC
        LIMIT ? OFFSET ?
      `).all(matchQuery, ...filter.values, fetchLimit, offset);

      const countRow = db.query<{ cnt: number }, unknown[]>(`
        SELECT COUNT(*) AS cnt
        FROM parts_fts
        JOIN parts p ON p.rowid = parts_fts.rowid
        WHERE parts_fts MATCH ?
        ${filter.sql}
      `).get(matchQuery, ...filter.values);

      return { rows, cnt: countRow?.cnt ?? 0 };
    } catch {
      return { rows: [], cnt: 0 };
    }
  };

  // Try strict AND first
  let { rows, cnt } = runFts(ftsAndQuery);

  // If AND returns no results, use smart token dropping then OR as last resort.
  // In fallback mode, fetch more results so the LCSC canonical boost can re-rank them.
  const FALLBACK_FETCH = Math.max(300, limit * 15);
  if (cnt === 0 && trimmed.includes(" ")) {
    const tokens = trimmed.split(/\s+/).filter(Boolean);

    if (tokens.length >= 2) {
      // Step 1: Find which tokens have zero individual FTS matches — drop those first.
      const tokMatchCounts = tokens.map((tok) => {
        const q = `"${tok.replace(/"/g, '""')}"*`;
        try { return { tok, cnt: db.query<{ cnt: number }, unknown[]>(`SELECT COUNT(*) AS cnt FROM parts_fts WHERE parts_fts MATCH ?`).get(q)?.cnt ?? 0 }; }
        catch { return { tok, cnt: 0 }; }
      });
      const matchingTokens = tokMatchCounts.filter((t) => t.cnt > 0).map((t) => t.tok);

      // Step 2: Try AND with only the matching tokens (if subset dropped some)
      if (matchingTokens.length >= 2 && matchingTokens.length < tokens.length) {
        const result = runFts(buildFtsQuery(matchingTokens.join(" ")), FALLBACK_FETCH);
        if (result.cnt > 0) {
          rows = result.rows;
          cnt = result.cnt;
        }
      }

      // Step 3: Still no results — progressively drop longest remaining tokens
      if (cnt === 0) {
        const tryTokens = matchingTokens.length >= 2 ? matchingTokens : tokens;
        const sortedByLength = [...tryTokens].sort((a, b) => b.length - a.length);
        const kept = new Set(tryTokens);

        for (const dropTok of sortedByLength) {
          if (kept.size < 2) break;
          kept.delete(dropTok);
          const remaining = tryTokens.filter((t) => kept.has(t));
          const result = runFts(buildFtsQuery(remaining.join(" ")), FALLBACK_FETCH);
          if (result.cnt > 0) {
            rows = result.rows;
            cnt = result.cnt;
            break;
          }
        }
      }
    }

    // Final fallback: OR semantics if still no results
    if (cnt === 0) {
      const orResult = runFts(ftsOrQuery);
      rows = orResult.rows;
      cnt = orResult.cnt;
    }
  }

  total = cnt;
  ftsResults = rows.map((r) => ({ ...rowToSummary(r), score: r.score as number }));

  // Apply application-layer boost
  ftsResults = applyBoost(ftsResults, trimmed);

  // Path 3: Fuzzy LIKE fallback when FTS returns few results and fuzzy is enabled
  if (params.fuzzy && ftsResults.length < 5) {
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const likeClauses = tokens
      .map(() => "(p.description LIKE ? OR p.mpn LIKE ? OR p.lcsc LIKE ?)")
      .join(" AND ");
    const likeValues = tokens.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);

    const fuzzyRows = db.query<Record<string, unknown>, unknown[]>(`
      SELECT ${SELECT_COLS}
      FROM parts p
      WHERE ${likeClauses}
      ${filter.sql}
      LIMIT ?
    `).all(...likeValues, ...filter.values, limit);

    const fuzzyResults = fuzzyRows.map(rowToSummary);

    // Merge: add fuzzy results not already in FTS results
    const seen = new Set(ftsResults.map((r) => r.lcsc));
    for (const r of fuzzyResults) {
      if (!seen.has(r.lcsc)) {
        ftsResults.push(r);
        seen.add(r.lcsc);
      }
    }
    total = Math.max(total, ftsResults.length);
  }

  return { results: ftsResults.slice(0, limit), total };
}
