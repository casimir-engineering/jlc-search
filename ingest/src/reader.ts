import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from "fs";
import { gunzipSync } from "bun";
import {
  jlcpartsIndexPath, jlcpartsDataPath, jlcpartsStockPath,
  jlcpartsHashesPath, jlcpcbManifestPath, jlcpcbPageDir,
  jlcpcbPagePath, lcscEnrichmentPath,
} from "./storage.ts";
import type {
  JlcpartsIndex, CategoryData, StockData,
  JlcpartsHashes, JlcpcbRunManifest, LcscEnrichmentRecord,
} from "./types.ts";

export function readLocalIndex(): JlcpartsIndex {
  return JSON.parse(readFileSync(jlcpartsIndexPath(), "utf8"));
}

export function readLocalHashes(): JlcpartsHashes {
  const path = jlcpartsHashesPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeLocalHashes(hashes: JlcpartsHashes): void {
  writeFileSync(jlcpartsHashesPath(), JSON.stringify(hashes, null, 2));
}

export function readLocalCategoryData(sourcename: string): CategoryData {
  const buf = readFileSync(jlcpartsDataPath(sourcename));
  const decompressed = gunzipSync(new Uint8Array(buf));
  return JSON.parse(new TextDecoder().decode(decompressed));
}

export function readLocalStockData(sourcename: string): StockData {
  return JSON.parse(readFileSync(jlcpartsStockPath(sourcename), "utf8"));
}

export function readJlcpcbManifest(): JlcpcbRunManifest {
  return JSON.parse(readFileSync(jlcpcbManifestPath(), "utf8"));
}

export function writeJlcpcbManifest(manifest: JlcpcbRunManifest): void {
  writeFileSync(jlcpcbManifestPath(), JSON.stringify(manifest, null, 2));
}

/** Read all page files for a query slug; returns the raw API response objects. */
export function readJlcpcbPageResponses(slug: string): unknown[] {
  const dir = jlcpcbPageDir(slug);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("page-") && f.endsWith(".json"))
    .sort();
  return files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
}

/** Count existing page files for a slug (for resume). */
export function countJlcpcbPages(slug: string): number {
  const dir = jlcpcbPageDir(slug);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.startsWith("page-") && f.endsWith(".json")).length;
}

/** Read LCSC enrichment NDJSON into a Map keyed by LCSC code. */
export function readLcscEnrichment(): Map<string, LcscEnrichmentRecord> {
  const path = lcscEnrichmentPath();
  const map = new Map<string, LcscEnrichmentRecord>();
  if (!existsSync(path)) return map;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as LcscEnrichmentRecord;
      if (record.lcsc) map.set(record.lcsc, record);
    } catch { /* skip malformed lines */ }
  }
  return map;
}

/** Append a single enrichment record to the NDJSON file. */
export function appendLcscEnrichment(record: LcscEnrichmentRecord): void {
  appendFileSync(lcscEnrichmentPath(), JSON.stringify(record) + "\n");
}
