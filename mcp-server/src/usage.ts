import { getSql } from "./db.ts";

/**
 * Fire-and-forget usage logging. Swallows all errors.
 */
export function logUsage(
  keyId: string,
  toolName: string,
  tookMs: number,
  resultCount?: number,
  error?: string
): void {
  const sql = getSql();
  sql`
    INSERT INTO mcp_usage_log (key_id, tool_name, took_ms, result_count, error)
    VALUES (${keyId}, ${toolName}, ${tookMs}, ${resultCount ?? null}, ${error ?? null})
  `.catch(() => {
    // swallow errors — usage logging should never break anything
  });
}
