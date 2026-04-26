import { scryptSync } from "node:crypto";
import { getSql } from "../db.ts";

const SALT = "kibrary-api-key-v1";

export interface KibraryKey {
  id: number;
  key_hash: string;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export function hashApiKey(rawKey: string): string {
  return scryptSync(rawKey, SALT, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

export async function insertKibraryKey(label: string, keyHash: string): Promise<number> {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO kibrary_api_keys (label, key_hash)
    VALUES (${label}, ${keyHash})
    RETURNING id
  `;
  return (rows[0] as any).id as number;
}

export async function findActiveKeyByHash(keyHash: string): Promise<KibraryKey | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, key_hash, label, created_at, last_used_at, revoked_at
    FROM kibrary_api_keys
    WHERE key_hash = ${keyHash} AND revoked_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rows[0] as unknown as KibraryKey;
}

export async function touchKeyLastUsed(id: number): Promise<void> {
  const sql = getSql();
  await sql`UPDATE kibrary_api_keys SET last_used_at = now() WHERE id = ${id}`;
}

export async function revokeKey(id: number): Promise<void> {
  const sql = getSql();
  await sql`UPDATE kibrary_api_keys SET revoked_at = now() WHERE id = ${id}`;
}
