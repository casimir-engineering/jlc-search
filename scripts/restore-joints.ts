import { Database } from "bun:sqlite";
import postgres from "postgres";

const BATCH_SIZE = 5000;

async function main() {
  // 1. Open SQLite readonly
  const sqliteDb = new Database("/home/sagan/Projects/jst-search/data/parts.db", { readonly: true });
  console.log("Opened SQLite database");

  // 2. Query all parts with joints > 0
  const rows = sqliteDb.query<{ lcsc: string; joints: number }, []>(
    "SELECT lcsc, joints FROM parts WHERE joints IS NOT NULL AND joints > 0"
  ).all();
  console.log(`Found ${rows.length} parts with joints data in SQLite`);

  if (rows.length === 0) {
    console.log("No rows to update, exiting.");
    sqliteDb.close();
    return;
  }

  // 3. Connect to PostgreSQL
  const sql = postgres("postgresql://jlc:jlc@localhost:5432/jlc", {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  console.log("Connected to PostgreSQL");

  // 4. Disable search trigger
  await sql`ALTER TABLE parts DISABLE TRIGGER trg_parts_search_vec`;
  console.log("Disabled search trigger");

  // 5. Batch update
  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const lcscs = batch.map((r) => r.lcsc);
    const jointsVals = batch.map((r) => r.joints);

    const result = await sql`
      UPDATE parts
      SET joints = v.joints
      FROM unnest(${lcscs}::text[], ${jointsVals}::int[]) AS v(lcsc, joints)
      WHERE parts.lcsc = v.lcsc
    `;

    updated += result.count;
    console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: updated ${result.count} rows (total: ${updated}/${rows.length})`);
  }

  // 6. Re-enable trigger
  await sql`ALTER TABLE parts ENABLE TRIGGER trg_parts_search_vec`;
  console.log("Re-enabled search trigger");

  console.log(`Done. Total rows updated in PostgreSQL: ${updated}`);

  // Cleanup
  sqliteDb.close();
  await sql.end();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
