import { getSql } from "./db.ts";

/** Daily call limits per tier. */
const DAILY_LIMITS: Record<string, number> = {
  hobbyist: 50,
  designer: 250,
  addict: 1500,
};

/** Cached daily counts: keyId → { count, date } */
const dailyCache = new Map<string, { count: number; date: string }>();

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10); // "2026-03-22"
}

/**
 * Check if a key has remaining daily quota.
 * Returns { allowed, remaining, limit } or { allowed: false, ... } if over limit.
 */
export async function checkDailyLimit(
  keyId: string,
  tier: string
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const limit = DAILY_LIMITS[tier] ?? DAILY_LIMITS.hobbyist;
  const today = todayUTC();

  // Check cache
  const cached = dailyCache.get(keyId);
  if (cached && cached.date === today) {
    if (cached.count >= limit) {
      return { allowed: false, remaining: 0, limit };
    }
    // Optimistic increment — the actual log INSERT happens after the tool call
    cached.count++;
    return { allowed: true, remaining: limit - cached.count, limit };
  }

  // Cache miss or new day — query DB for today's count
  const sql = getSql();
  const rows = await sql`
    SELECT COUNT(*)::int AS cnt FROM mcp_usage_log
    WHERE key_id = ${keyId} AND called_at >= ${today}::date
  `;
  const count = (rows[0]?.cnt as number) ?? 0;

  dailyCache.set(keyId, { count: count + 1, date: today });

  if (count >= limit) {
    return { allowed: false, remaining: 0, limit };
  }
  return { allowed: true, remaining: limit - count - 1, limit };
}

/** Get the daily limit for a tier. */
export function getDailyLimit(tier: string): number {
  return DAILY_LIMITS[tier] ?? DAILY_LIMITS.hobbyist;
}
