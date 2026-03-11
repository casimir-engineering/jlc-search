import postgres from "postgres";
import { applySchema } from "./schema.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is required");
  process.exit(1);
}

let _sql: ReturnType<typeof postgres> | null = null;
let _ready: Promise<void> | null = null;

export function getSql(): ReturnType<typeof postgres> {
  if (_sql) return _sql;
  _sql = postgres(DATABASE_URL, {
    max: 20,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},  // suppress NOTICE logs
    connection: { statement_timeout: 10_000 },  // kill queries after 10s
  });
  _ready = applySchema(_sql);
  return _sql;
}

/** Wait for schema to be applied. Call once at startup. */
export async function waitForDb(): Promise<void> {
  getSql();
  await _ready;
}

/** Close the connection pool. Call on shutdown. */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
    _ready = null;
  }
}
