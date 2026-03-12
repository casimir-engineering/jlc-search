/**
 * Prevents hammering external APIs by:
 * 1. Deduplicating: skip if we already refreshed this LCSC code recently
 * 2. Concurrency limiting: max N concurrent requests
 */

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes — don't re-fetch within this window
const MAX_CONCURRENT = 3; // max concurrent API calls per source

interface RefreshState {
  lastRefreshed: Map<string, number>; // lcsc -> timestamp
  active: number;
  queue: Array<() => void>;
}

function createLimiter(): RefreshState {
  return { lastRefreshed: new Map(), active: 0, queue: [] };
}

const limiters: Record<string, RefreshState> = {};

function getLimiter(source: string): RefreshState {
  if (!limiters[source]) limiters[source] = createLimiter();
  return limiters[source];
}

/** Returns true if the refresh should proceed, false if it should be skipped. */
export function shouldRefresh(source: string, lcsc: string): boolean {
  const limiter = getLimiter(source);
  const now = Date.now();
  const last = limiter.lastRefreshed.get(lcsc);
  if (last && now - last < CACHE_TTL) return false;
  limiter.lastRefreshed.set(lcsc, now);

  // Periodically clean old entries to prevent memory leak
  if (limiter.lastRefreshed.size > 10000) {
    for (const [k, v] of limiter.lastRefreshed) {
      if (now - v > CACHE_TTL) limiter.lastRefreshed.delete(k);
    }
  }

  return true;
}

/** Wraps an async function with concurrency limiting. */
export function withConcurrencyLimit(
  source: string,
  fn: () => Promise<void>,
): void {
  const limiter = getLimiter(source);

  const run = () => {
    limiter.active++;
    fn().finally(() => {
      limiter.active--;
      const next = limiter.queue.shift();
      if (next) next();
    });
  };

  if (limiter.active < MAX_CONCURRENT) {
    run();
  } else {
    limiter.queue.push(run);
  }
}
