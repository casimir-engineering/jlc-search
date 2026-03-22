import type { Sql } from "postgres";

/** Apply MCP-specific schema tables (idempotent). */
export async function applyMcpSchema(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'hobbyist',
      patreon_member_id TEXT,
      patreon_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `;

  // Add key_plaintext column for showing key on /key page
  await sql`
    DO $$ BEGIN
      ALTER TABLE mcp_api_keys ADD COLUMN key_plaintext TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS mcp_usage_log (
      id BIGSERIAL PRIMARY KEY,
      key_id TEXT NOT NULL REFERENCES mcp_api_keys(id),
      tool_name TEXT NOT NULL,
      called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      took_ms INTEGER,
      result_count INTEGER,
      error TEXT
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_usage_key_time ON mcp_usage_log(key_id, called_at)
  `;
}
