/** Returns true if the query looks like an LCSC part code (e.g. "C10", "c123456") */
export function detectLcscCode(q: string): boolean {
  return /^c\d+$/i.test(q.trim());
}

// ── tsquery builders (PostgreSQL) ──────────────────────────────────────

/** Remove characters that are special in tsquery syntax. Keep dots/hyphens (simple dict preserves them). */
function sanitize(tok: string): string {
  return tok.replace(/[&|!():*<>'\\]/g, "").toLowerCase().trim();
}

/**
 * Should this token use prefix matching (:*)?
 * Always yes — users expect partial words to match (e.g. "pada" → "padauk").
 * The GIN index handles prefix scans efficiently, and common words like "led"
 * already match ~80k rows with exact match so prefix adds marginal cost.
 */
function needsPrefix(_tok: string): boolean {
  return true;
}

/**
 * Convert a single search token into a tsquery expression fragment.
 * The 'simple' dictionary preserves dots and hyphens in tokens
 * (e.g. "1.25" stays as one token, "RC0402JR-07100KL" becomes both
 * the full form and sub-tokens).
 * All tokens get :* prefix for substring-style matching.
 */
function tokenToTsExpr(tok: string): string {
  const clean = sanitize(tok);
  if (!clean) return "";
  return needsPrefix(clean) ? `${clean}:*` : clean;
}

/**
 * Build a PostgreSQL tsquery string (AND): all tokens must match.
 * Result is passed to to_tsquery('simple', ...).
 */
export function buildTsQuery(text: string, phrases: string[] = []): string {
  const exprs: string[] = [];

  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    const e = tokenToTsExpr(tok);
    if (e) exprs.push(e);
  }

  for (const phrase of phrases) {
    const words = sanitize(phrase).split(/\s+/).filter(Boolean);
    if (words.length > 0) exprs.push(`(${words.map(w => needsPrefix(w) ? `${w}:*` : w).join(" <-> ")})`);
  }

  return exprs.join(" & ") || "";
}

/**
 * Build a PostgreSQL tsquery string (OR): any token can match.
 * Phrases are still AND-constrainted.
 */
export function buildTsOrQuery(text: string, phrases: string[] = []): string {
  const tokenExprs: string[] = [];

  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    const e = tokenToTsExpr(tok);
    if (e) tokenExprs.push(e);
  }

  let result = "";
  if (tokenExprs.length === 1) result = tokenExprs[0];
  else if (tokenExprs.length > 1) result = `(${tokenExprs.join(" | ")})`;

  // Phrases constrain (AND) the OR result
  for (const phrase of phrases) {
    const words = sanitize(phrase).split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      const pe = `(${words.map(w => needsPrefix(w) ? `${w}:*` : w).join(" <-> ")})`;
      result = result ? `${result} & ${pe}` : pe;
    }
  }

  return result || "";
}

/**
 * Build a tsquery for negated terms (OR'd together).
 * Used as: NOT search_vec @@ to_tsquery('simple', negQuery)
 */
export function buildNegationTsQuery(negations: string[]): string {
  const exprs = negations.map(tokenToTsExpr).filter(Boolean);
  return exprs.join(" | ");
}

// ── Range filter parsing (unchanged from SQLite version) ──────────────

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
  if (["V", "Ohm", "F", "A", "H", "W", "Hz"].includes(raw)) return raw;
  return UNIT_ALIASES[raw.toLowerCase()] ?? null;
}

export interface RangeFilter {
  unit: string;
  op: "gt" | "gte" | "lt" | "lte" | "eq" | "between";
  value: number;
  min: number;
  max: number;
}

export interface ParsedQuery {
  text: string;
  phrases: string[];
  negations: string[];
  filterGroups: RangeFilter[][];
}

function parseFilterToken(token: string): RangeFilter | null {
  const colonIdx = token.indexOf(":");
  if (colonIdx < 1) return null;

  const unitRaw = token.slice(0, colonIdx);
  const unit = resolveUnit(unitRaw);
  if (!unit) return null;

  const expr = token.slice(colonIdx + 1);
  if (!expr) return null;

  const rangeMatch = expr.match(/^(-?\d+\.?\d*(?:[GMkmunp])?)->(-?\d+\.?\d*(?:[GMkmunp])?)$/);
  if (rangeMatch) {
    const min = parseSIValue(rangeMatch[1]);
    const max = parseSIValue(rangeMatch[2]);
    if (min !== null && max !== null) {
      return { unit, op: "between", value: 0, min, max };
    }
  }

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

  const bareValue = parseSIValue(expr);
  if (bareValue !== null) {
    return { unit, op: "eq", value: bareValue, min: 0, max: 0 };
  }

  return null;
}

export function parseQuery(raw: string): ParsedQuery {
  const phrases: string[] = [];
  const negations: string[] = [];

  const withoutPhrases = raw.replace(/-?"([^"]+)"/g, (match, phrase) => {
    const trimmed = (phrase as string).trim();
    if (!trimmed) return " ";
    if (match.startsWith("-")) {
      negations.push(trimmed);
    } else {
      phrases.push(trimmed);
    }
    return " ";
  });

  const tokens = withoutPhrases.trim().split(/\s+/).filter(Boolean);
  const textTokens: string[] = [];
  const filterGroups: RangeFilter[][] = [[]];

  for (const tok of tokens) {
    if (tok === "|") {
      if (filterGroups[filterGroups.length - 1].length > 0) filterGroups.push([]);
      continue;
    }
    if (tok === "&") continue;

    if (tok.startsWith("-") && tok.length > 1) {
      negations.push(tok.slice(1));
      continue;
    }

    const filter = parseFilterToken(tok);
    if (filter) {
      filterGroups[filterGroups.length - 1].push(filter);
    } else {
      textTokens.push(tok);
    }
  }

  if (filterGroups[filterGroups.length - 1].length === 0 && filterGroups.length > 1) {
    filterGroups.pop();
  }

  return {
    text: textTokens.join(" "),
    phrases,
    negations,
    filterGroups: filterGroups.filter((g) => g.length > 0),
  };
}
