import postgres from "postgres";
import { applySchema } from "../../backend/src/schema.ts";

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
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { statement_timeout: 10_000 },
  });
  _ready = applySchema(_sql);
  return _sql;
}

export async function waitForDb(): Promise<void> {
  getSql();
  await _ready;
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
    _ready = null;
  }
}
