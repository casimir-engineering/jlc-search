/** Returns true if the query looks like an LCSC part code (e.g. "C10", "c123456") */
export function detectLcscCode(q: string): boolean {
  return /^c\d+$/i.test(q.trim());
}

/**
 * Build an FTS5 AND query: all tokens must match.
 * Every token gets a prefix wildcard so "1.25" matches "1.25mm",
 * "100nF" matches "100nF" exactly, etc.
 */
export function buildFtsQuery(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';

  return tokens
    .map((tok) => {
      const escaped = tok.replace(/"/g, '""');
      return `"${escaped}"*`;
    })
    .join(" ");
}

/**
 * Build an FTS5 OR query: any token can match.
 * Useful fallback when AND returns no results.
 */
export function buildFtsOrQuery(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';

  return tokens
    .map((tok, i) => {
      const escaped = tok.replace(/"/g, '""');
      return i === tokens.length - 1
        ? `"${escaped}"*`
        : `"${escaped}"`;
    })
    .join(" OR ");
}

// ── Range filter parsing ──────────────────────────────────────────────

const SI_MULTIPLIERS: Record<string, number> = {
  G: 1e9, M: 1e6, k: 1e3,
  m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12,
};

/** Parse a value string with optional SI prefix: "100n" → 1e-7, "10k" → 10000 */
export function parseSIValue(s: string): number | null {
  const match = s.match(/^(-?\d+\.?\d*)(G|M|k|m|u|n|p)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (!isFinite(num)) return null;
  const mult = match[2] ? SI_MULTIPLIERS[match[2]] : 1;
  return num * mult;
}

/** Canonical unit aliases → stored unit name */
const UNIT_ALIASES: Record<string, string> = {
  v: "V", volt: "V", volts: "V",
  ohm: "Ohm", ohms: "Ohm", r: "Ohm",
  f: "F", farad: "F", farads: "F",
  a: "A", amp: "A", amps: "A",
  h: "H", henry: "H",
  w: "W", watt: "W", watts: "W",
  hz: "Hz", hertz: "Hz",
  pads: "_pads", pad: "_pads",
};

function resolveUnit(raw: string): string | null {
  // Exact match first (case-sensitive for V vs v ambiguity)
  if (["V", "Ohm", "F", "A", "H", "W", "Hz"].includes(raw)) return raw;
  return UNIT_ALIASES[raw.toLowerCase()] ?? null;
}

export interface RangeFilter {
  unit: string;
  op: "gt" | "gte" | "lt" | "lte" | "eq" | "between";
  value: number;  // used for single-value ops
  min: number;    // used for 'between'
  max: number;    // used for 'between'
}

export interface ParsedQuery {
  text: string;                    // FTS text tokens
  filterGroups: RangeFilter[][];   // DNF: OR of AND-groups
}

/**
 * Parse a single range filter token like "V:>25", "Ohm:<2m", "F:100n->1u"
 * Returns null if it doesn't match the filter syntax.
 */
function parseFilterToken(token: string): RangeFilter | null {
  const colonIdx = token.indexOf(":");
  if (colonIdx < 1) return null;

  const unitRaw = token.slice(0, colonIdx);
  const unit = resolveUnit(unitRaw);
  if (!unit) return null;

  const expr = token.slice(colonIdx + 1);
  if (!expr) return null;

  // Range: min->max
  const rangeMatch = expr.match(/^(-?\d+\.?\d*(?:[GMkmunp])?)->(-?\d+\.?\d*(?:[GMkmunp])?)$/);
  if (rangeMatch) {
    const min = parseSIValue(rangeMatch[1]);
    const max = parseSIValue(rangeMatch[2]);
    if (min !== null && max !== null) {
      return { unit, op: "between", value: 0, min, max };
    }
  }

  // Comparison: >=, <=, >, <, =
  const cmpMatch = expr.match(/^(>=|<=|>|<|=)(-?\d+\.?\d*(?:[GMkmunp])?)$/);
  if (cmpMatch) {
    const value = parseSIValue(cmpMatch[2]);
    if (value !== null) {
      const opMap: Record<string, RangeFilter["op"]> = {
        ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", "=": "eq",
      };
      return { unit, op: opMap[cmpMatch[1]], value, min: 0, max: 0 };
    }
  }

  // Bare value: exact match
  const bareValue = parseSIValue(expr);
  if (bareValue !== null) {
    return { unit, op: "eq", value: bareValue, min: 0, max: 0 };
  }

  return null;
}

/**
 * Parse a full query string into text tokens and range filter groups.
 *
 * Range filters use the syntax: UNIT:OP_VALUE or UNIT:MIN->MAX
 * Multiple filters default to AND; use | for OR between filters.
 *
 * Examples:
 *   "100nF X7R V:>25"         → text="100nF X7R", filters=[[V>25]]
 *   "V:-15->20"               → text="", filters=[[V:-15..20]]
 *   "Ohm:10k->100k W:>0.25"   → text="", filters=[[Ohm:10k..100k, W>0.25]]
 *   "Ohm:<2m | Ohm:>1M"       → text="", filters=[[Ohm<0.002], [Ohm>1e6]]
 */
export function parseQuery(raw: string): ParsedQuery {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const textTokens: string[] = [];
  const filterGroups: RangeFilter[][] = [[]];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Handle logical operators
    if (tok === "|") {
      // Start new OR group only if current group has filters
      if (filterGroups[filterGroups.length - 1].length > 0) {
        filterGroups.push([]);
      }
      continue;
    }
    if (tok === "&") continue; // AND is default, skip

    // Try parsing as range filter
    const filter = parseFilterToken(tok);
    if (filter) {
      filterGroups[filterGroups.length - 1].push(filter);
    } else {
      textTokens.push(tok);
    }
  }

  // Clean up empty trailing group
  if (filterGroups[filterGroups.length - 1].length === 0 && filterGroups.length > 1) {
    filterGroups.pop();
  }

  return {
    text: textTokens.join(" "),
    filterGroups: filterGroups.filter((g) => g.length > 0),
  };
}

/**
 * Build SQL WHERE clause and params for range filter groups (DNF).
 * Returns empty string if no filters.
 */
export function buildFilterSql(filterGroups: RangeFilter[][]): { sql: string; values: unknown[] } {
  if (filterGroups.length === 0) return { sql: "", values: [] };

  const values: unknown[] = [];
  const orClauses: string[] = [];

  for (const group of filterGroups) {
    const andClauses: string[] = [];
    for (const f of group) {
      let condition: string;
      switch (f.op) {
        case "gt":
          condition = "pn.value > ?";
          values.push(f.unit, f.value);
          break;
        case "gte":
          condition = "pn.value >= ?";
          values.push(f.unit, f.value);
          break;
        case "lt":
          condition = "pn.value < ?";
          values.push(f.unit, f.value);
          break;
        case "lte":
          condition = "pn.value <= ?";
          values.push(f.unit, f.value);
          break;
        case "eq":
          condition = "pn.value = ?";
          values.push(f.unit, f.value);
          break;
        case "between":
          condition = "pn.value BETWEEN ? AND ?";
          values.push(f.unit, f.min, f.max);
          break;
      }
      andClauses.push(
        `EXISTS (SELECT 1 FROM part_nums pn WHERE pn.lcsc = p.lcsc AND pn.unit = ? AND ${condition!})`
      );
    }
    orClauses.push(andClauses.length === 1 ? andClauses[0] : `(${andClauses.join(" AND ")})`);
  }

  const sql = orClauses.length === 1
    ? `AND ${orClauses[0]}`
    : `AND (${orClauses.join(" OR ")})`;

  return { sql, values };
}
