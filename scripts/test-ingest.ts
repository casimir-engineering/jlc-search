/**
 * Ingest writer test suite.
 * Tests dedup, upsert stats, batch stock update, and crash recovery.
 * Runs against a live PostgreSQL database — uses test-prefixed LCSC codes
 * that are cleaned up after each test.
 *
 * Usage: bun run scripts/test-ingest.ts
 */
import postgres from "postgres";
import { applySchema } from "../backend/src/schema.ts";
import {
  bulkInsertParts,
  bulkUpdateStock,
  recoverFromCrash,
  disableSearchTrigger,
  enableSearchTrigger,
  rebuildSearchVectors,
} from "../ingest/src/writer.ts";
import type { PartRow } from "../ingest/src/types.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jlc:jlc@localhost:5432/jlc";
const PREFIX = "CTEST";

function makePart(id: number, overrides?: Partial<PartRow>): PartRow {
  return {
    lcsc: `${PREFIX}${id}`,
    mpn: `TEST-MPN-${id}`,
    manufacturer: "TestCorp",
    category: "Test",
    subcategory: "Test Parts",
    description: `Test part number ${id}`,
    datasheet: null,
    package: "0402",
    joints: 2,
    stock: 100,
    jlc_stock: 0,
    price_raw: "1-10:0.01,10-100:0.005",
    img: null,
    url: null,
    part_type: "Basic",
    pcba_type: "Economic+Standard",
    attributes: "{}",
    search_text: "",
    ...overrides,
  };
}

interface Test {
  name: string;
  fn: (sql: ReturnType<typeof postgres>) => Promise<string | null>;
}

const tests: Test[] = [
  {
    name: "Insert new parts returns correct inserted count",
    fn: async (sql) => {
      const parts = [makePart(1), makePart(2), makePart(3)];
      const stats = await bulkInsertParts(sql, parts);
      if (stats.inserted !== 3) return `expected 3 inserted, got ${stats.inserted}`;
      if (stats.updated !== 0) return `expected 0 updated, got ${stats.updated}`;
      return null;
    },
  },
  {
    name: "Re-insert same parts returns correct updated count",
    fn: async (sql) => {
      const parts = [makePart(1), makePart(2), makePart(3)];
      await bulkInsertParts(sql, parts);
      const stats = await bulkInsertParts(sql, parts);
      if (stats.inserted !== 0) return `expected 0 inserted, got ${stats.inserted}`;
      if (stats.updated !== 3) return `expected 3 updated, got ${stats.updated}`;
      return null;
    },
  },
  {
    name: "Within-batch duplicates don't crash",
    fn: async (sql) => {
      const parts = [
        makePart(1, { description: "first" }),
        makePart(2),
        makePart(1, { description: "second" }),  // duplicate LCSC
      ];
      const stats = await bulkInsertParts(sql, parts);
      // Should not crash, and dedup keeps last occurrence
      const [row] = await sql`SELECT description FROM parts WHERE lcsc = ${`${PREFIX}1`}`;
      if (row?.description !== "second") return `expected 'second', got '${row?.description}'`;
      if (stats.inserted + stats.updated !== 2) return `expected 2 total rows, got ${stats.inserted + stats.updated}`;
      return null;
    },
  },
  {
    name: "Batch stock update works",
    fn: async (sql) => {
      await bulkInsertParts(sql, [makePart(1, { stock: 100 }), makePart(2, { stock: 200 })]);
      await bulkUpdateStock(sql, { [`${PREFIX}1`]: 999, [`${PREFIX}2`]: 0 });
      const rows = await sql`SELECT lcsc, stock FROM parts WHERE lcsc IN (${`${PREFIX}1`}, ${`${PREFIX}2`}) ORDER BY lcsc`;
      if (rows[0]?.stock !== 999) return `expected stock=999 for part 1, got ${rows[0]?.stock}`;
      if (rows[1]?.stock !== 0) return `expected stock=0 for part 2, got ${rows[1]?.stock}`;
      return null;
    },
  },
  {
    name: "Crash recovery detects NULL search_vec",
    fn: async (sql) => {
      // Insert with trigger enabled so search_vec is populated
      await enableSearchTrigger(sql);
      await bulkInsertParts(sql, [makePart(1)]);

      // Simulate crash: disable trigger, insert part with NULL search_vec
      await disableSearchTrigger(sql);
      await sql`INSERT INTO parts (lcsc, mpn, category, subcategory, description, stock, price_raw, part_type, pcba_type, attributes, search_text)
        VALUES (${`${PREFIX}2`}, 'CRASH-TEST', '', '', 'crash test part', 0, '', 'Basic', 'Standard', '{}', '')`;

      // Verify search_vec is NULL
      const [before] = await sql`SELECT search_vec FROM parts WHERE lcsc = ${`${PREFIX}2`}`;
      if (before?.search_vec !== null) return `expected NULL search_vec before recovery`;

      // Run recovery
      await recoverFromCrash(sql);

      // Verify search_vec is now populated
      const [after] = await sql`SELECT search_vec FROM parts WHERE lcsc = ${`${PREFIX}2`}`;
      if (!after?.search_vec) return `expected non-NULL search_vec after recovery, got ${after?.search_vec}`;
      return null;
    },
  },
  {
    name: "Numeric attributes are inserted",
    fn: async (sql) => {
      const parts = [makePart(1, { attributes: JSON.stringify({ "Resistance": "10kΩ" }), description: "10kOhm resistor" })];
      await bulkInsertParts(sql, parts);
      const nums = await sql`SELECT unit, value FROM part_nums WHERE lcsc = ${`${PREFIX}1`}`;
      if (nums.length === 0) return "expected numeric attributes, got none";
      return null;
    },
  },
  {
    name: "Numeric attributes are replaced on re-insert",
    fn: async (sql) => {
      await bulkInsertParts(sql, [makePart(1, { description: "100nF capacitor" })]);
      const before = await sql`SELECT COUNT(*) AS cnt FROM part_nums WHERE lcsc = ${`${PREFIX}1`}`;

      // Re-insert with different description
      await bulkInsertParts(sql, [makePart(1, { description: "10uF capacitor" })]);
      const after = await sql`SELECT COUNT(*) AS cnt FROM part_nums WHERE lcsc = ${`${PREFIX}1`}`;

      // Should have replaced, not accumulated
      const [row] = await sql`SELECT description FROM parts WHERE lcsc = ${`${PREFIX}1`}`;
      if (row?.description !== "10uF capacitor") return `expected updated description, got '${row?.description}'`;
      return null;
    },
  },
];

async function cleanup(sql: ReturnType<typeof postgres>) {
  await sql`DELETE FROM part_nums WHERE lcsc LIKE ${`${PREFIX}%`}`;
  await sql`DELETE FROM parts WHERE lcsc LIKE ${`${PREFIX}%`}`;
  await enableSearchTrigger(sql);
}

async function main() {
  const sql = postgres(DATABASE_URL, { max: 5, onnotice: () => {} });
  await applySchema(sql);

  console.log("Testing ingest writer against live PostgreSQL\n");

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    await cleanup(sql);
    try {
      const error = await t.fn(sql);
      const icon = error ? "FAIL" : "PASS";
      console.log(`  ${icon}  ${t.name}`);
      if (error) {
        console.log(`        ${error}`);
        failed++;
      } else {
        passed++;
      }
    } catch (err) {
      console.log(`  FAIL  ${t.name}`);
      console.log(`        THREW: ${err}`);
      failed++;
    }
  }

  await cleanup(sql);
  await sql.end();

  console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
  if (failed > 0) process.exit(1);
}

main();
