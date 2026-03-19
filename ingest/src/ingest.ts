/**
 * Combined ingest: download + process for jlcparts mirror data.
 * Backward-compatible entry point.
 */
import { mkdirSync } from "fs";
import { downloadJlcparts } from "./download-jlcparts.ts";
import { processJlcparts } from "./process-jlcparts.ts";

// Ensure data/img directory exists for image caching
mkdirSync("data/img", { recursive: true });

async function main() {
  console.log("jlc-search ingest (download + process)");
  await downloadJlcparts();
  await processJlcparts();
}

main().catch((err) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
