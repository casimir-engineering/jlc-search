import type { MiddlewareHandler } from "hono";
import { findActiveKeyByHash, hashApiKey, touchKeyLastUsed } from "../db/kibrary-keys.ts";

export interface KibraryKeyCtx {
  keyId: number;
  label: string;
}

export type KibraryEnv = { Variables: { kibraryKey: KibraryKeyCtx } };

const BEARER_RE = /^Bearer (.+)$/i;

export function kibraryAuth(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header("Authorization");
    const match = auth ? BEARER_RE.exec(auth) : null;
    if (!match) {
      return c.json(
        { error: "Authorization header required. Use: Authorization: Bearer <key>" },
        401,
      );
    }
    const token = match[1].trim();
    const digest = hashApiKey(token);
    const key = await findActiveKeyByHash(digest);
    if (!key) {
      return c.json({ error: "Invalid or revoked API key" }, 401);
    }
    touchKeyLastUsed(key.id).catch((e) => console.error("touchKeyLastUsed failed", e));
    c.set("kibraryKey", { keyId: key.id, label: key.label } satisfies KibraryKeyCtx);
    await next();
  };
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const CAPACITIES = { search: 60, part: 600 } as const;
const REFILL_MS = 60_000;
const EVICT_AFTER_MS = 5 * 60_000;

const buckets = new Map<string, Bucket>();

export function kibraryRateLimit(type: "search" | "part"): MiddlewareHandler {
  const capacity = CAPACITIES[type];
  return async (c, next) => {
    const ctx = c.get("kibraryKey") as KibraryKeyCtx | undefined;
    if (!ctx) {
      return c.json({ error: "Invalid or revoked API key" }, 401);
    }
    const bucketKey = `${type}:${ctx.keyId}`;
    const now = Date.now();
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      buckets.set(bucketKey, bucket);
    } else {
      const elapsed = now - bucket.lastRefill;
      if (elapsed > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / REFILL_MS) * capacity);
        bucket.lastRefill = now;
      }
    }
    bucket.tokens -= 1;
    if (bucket.tokens < 0) {
      c.header("Retry-After", "60");
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    // Cheap memory hygiene: occasionally evict idle buckets.
    if (buckets.size > 1024 && Math.random() < 0.01) {
      for (const [k, b] of buckets) {
        if (now - b.lastRefill > EVICT_AFTER_MS) buckets.delete(k);
      }
    }

    await next();
  };
}
