import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema.ts";
import { join } from "path";

const dbPath = process.env.DB_PATH ?? join(import.meta.dir, "../../data/parts.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(dbPath, { create: true });
  // Apply schema (idempotent — uses IF NOT EXISTS)
  _db.exec(SCHEMA_SQL);
  return _db;
}
