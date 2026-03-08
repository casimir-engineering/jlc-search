/** Returns true if the query looks like an LCSC part code (e.g. "C10", "c123456") */
export function detectLcscCode(q: string): boolean {
  return /^c\d+$/i.test(q.trim());
}

/**
 * Build an FTS5 AND query: all tokens must match.
 * Every token gets a prefix wildcard so "1.25" matches "1.25mm",
 * "100nF" matches "100nF" exactly, etc.
 *
 * Examples:
 *   "100nF"          → '"100nF"*'
 *   "100nF 0402"     → '"100nF"* "0402"*'
 *   "1.25 smd"       → '"1.25"* "smd"*'
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
 *
 * Examples:
 *   "1.25 picoblade smd" → '"1.25" OR "picoblade" OR "smd"*'
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
