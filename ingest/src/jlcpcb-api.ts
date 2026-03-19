/**
 * Combined ingest: download JLCPCB + download LCSC enrichment + process.
 * Backward-compatible entry point.
 *
 * Usage: bun run ingest/src/jlcpcb-api.ts [--fresh] [--categories "Cat1|Cat2"] [--instock-only]
 */
import { downloadJlcpcb } from "./download-jlcpcb.ts";
import { downloadLcsc } from "./download-lcsc.ts";
import { processJlcpcb } from "./process-jlcpcb.ts";

async function main() {
  const flags = process.argv.slice(2);
  console.log("JLCPCB API ingest (download + enrich + process)");
  await downloadJlcpcb(flags);
  await downloadLcsc(flags);
  await processJlcpcb();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
