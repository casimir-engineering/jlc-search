/**
 * Backfill mounting type keywords (SMD/SMT/THT/TH) into search_text
 * for all existing parts, based on package name and attributes.
 *
 * Usage: bun run scripts/backfill-mounting-type.ts
 *
 * This reads all distinct package names, classifies them using
 * inferMountingType(), then batch-updates search_text and rebuilds
 * search vectors for affected rows.
 */
import postgres from "postgres";
import { inferMountingType } from "../ingest/src/attrs.ts";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://jlc:jlc@localhost:5432/jlc";
const sql = postgres(DATABASE_URL);

async function main() {
  // 1. Get all distinct package values
  console.log("Fetching distinct package names...");
  const pkgRows = await sql`
    SELECT DISTINCT package FROM parts
    WHERE package IS NOT NULL AND package != '' AND package != '-'
  `;
  console.log(`  ${pkgRows.length} distinct packages`);

  // 2. Classify each package
  const smdPkgs: string[] = [];
  const thtPkgs: string[] = [];
  for (const row of pkgRows) {
    const mt = inferMountingType(row.package, "");
    if (mt.includes("SMD")) smdPkgs.push(row.package);
    else if (mt.includes("THT")) thtPkgs.push(row.package);
  }
  console.log(`  SMD packages: ${smdPkgs.length}, THT packages: ${thtPkgs.length}, unclassified: ${pkgRows.length - smdPkgs.length - thtPkgs.length}`);

  // 3. Update SMD parts (by package name)
  console.log("Updating SMD parts by package...");
  const smdPkgResult = await sql`
    UPDATE parts SET
      search_text = CASE WHEN coalesce(search_text, '') = '' THEN 'SMD SMT surface-mount'
                         ELSE search_text || ' SMD SMT surface-mount' END,
      search_vec = NULL
    WHERE package = ANY(${smdPkgs})
      AND coalesce(search_text, '') NOT LIKE '%SMD SMT surface-mount%'
  `;
  console.log(`  Updated ${smdPkgResult.count} rows`);

  // 4. Update THT parts (by package name)
  console.log("Updating THT parts by package...");
  const thtPkgResult = await sql`
    UPDATE parts SET
      search_text = CASE WHEN coalesce(search_text, '') = '' THEN 'THT TH through-hole'
                         ELSE search_text || ' THT TH through-hole' END,
      search_vec = NULL
    WHERE package = ANY(${thtPkgs})
      AND coalesce(search_text, '') NOT LIKE '%THT TH through-hole%'
  `;
  console.log(`  Updated ${thtPkgResult.count} rows`);

  // 5. Update by attributes (catches parts with unclassified packages but explicit mounting info)
  console.log("Updating SMD parts by attributes...");
  const smdAttrResult = await sql`
    UPDATE parts SET
      search_text = CASE WHEN coalesce(search_text, '') = '' THEN 'SMD SMT surface-mount'
                         ELSE search_text || ' SMD SMT surface-mount' END,
      search_vec = NULL
    WHERE (attributes::text ILIKE '%Surface Mount%'
        OR attributes::text ILIKE '%Reverse Mount%'
        OR attributes::text ILIKE '%Top-mount%'
        OR attributes::text ILIKE '%Side View Mount%')
      AND coalesce(search_text, '') NOT LIKE '%SMD SMT surface-mount%'
  `;
  console.log(`  Updated ${smdAttrResult.count} rows`);

  console.log("Updating THT parts by attributes...");
  const thtAttrResult = await sql`
    UPDATE parts SET
      search_text = CASE WHEN coalesce(search_text, '') = '' THEN 'THT TH through-hole'
                         ELSE search_text || ' THT TH through-hole' END,
      search_vec = NULL
    WHERE (attributes::text ILIKE '%Through Hole%'
        OR attributes::text ILIKE '%through-hole%')
      AND coalesce(search_text, '') NOT LIKE '%THT TH through-hole%'
      AND coalesce(search_text, '') NOT LIKE '%SMD SMT surface-mount%'
  `;
  console.log(`  Updated ${thtAttrResult.count} rows`);

  // 6. Rebuild search vectors and full_text for all updated rows
  const totalUpdated = Number(smdPkgResult.count) + Number(thtPkgResult.count) +
                       Number(smdAttrResult.count) + Number(thtAttrResult.count);
  console.log(`\nRebuilding search vectors for ${totalUpdated} rows...`);
  await sql`
    UPDATE parts SET
      search_vec =
        setweight(to_tsvector('simple', coalesce(lcsc, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(mpn, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(manufacturer, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(subcategory, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(search_text, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(package, '')), 'D'),
      full_text = lower(concat_ws(' ', lcsc, mpn,
        coalesce(manufacturer, ''), description,
        coalesce(subcategory, ''), coalesce(search_text, ''),
        coalesce(package, '')))
    WHERE search_vec IS NULL
  `;
  console.log("Done!");

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
