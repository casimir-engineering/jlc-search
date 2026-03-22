import type { Context, Next } from "hono";
import { getSql } from "./db.ts";

interface CachedKey {
  id: string;
  tier: string;
  name: string;
  cachedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const keyCache = new Map<string, CachedKey>();

/** SHA-256 hash a string, return hex. */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return [...hashArray].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Paths that skip authentication. */
const PUBLIC_PATHS = ["/health", "/webhooks/patreon", "/key"];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "?") || path.startsWith(p + "/"));
}

/** Hono middleware: Bearer token auth against mcp_api_keys. */
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  // Skip auth if disabled
  if (process.env.MCP_REQUIRE_AUTH !== "true") {
    return next();
  }

  // Skip auth on public routes
  if (isPublicPath(new URL(c.req.url).pathname)) {
    return next();
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Missing Authorization header. Use: Bearer jlc_..." },
      id: null,
    }, 401);
  }

  const token = authHeader.slice(7).trim();
  if (!token.startsWith("jlc_") || token.length !== 36) {
    return c.json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid API key format" },
      id: null,
    }, 403);
  }

  // Check cache first
  const now = Date.now();
  const cached = keyCache.get(token);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    c.set("apiKey", { id: cached.id, tier: cached.tier, name: cached.name });
    return next();
  }

  // Hash and look up in DB
  const hash = await sha256(token);
  const sql = getSql();

  const rows = await sql`
    SELECT id, tier, name FROM mcp_api_keys
    WHERE key_hash = ${hash}
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > NOW())
  `;

  if (rows.length === 0) {
    // Remove stale cache entry if present
    keyCache.delete(token);
    return c.json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or expired API key" },
      id: null,
    }, 403);
  }

  const row = rows[0];
  const keyInfo = { id: row.id as string, tier: row.tier as string, name: row.name as string };

  // Cache the validated key
  keyCache.set(token, { ...keyInfo, cachedAt: now });

  c.set("apiKey", keyInfo);
  return next();
}
