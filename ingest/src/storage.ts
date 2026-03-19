import { mkdirSync } from "fs";
import { join } from "path";

export const RAW_DIR = "data/raw";
export const JLCPARTS_DIR = join(RAW_DIR, "jlcparts");
export const JLCPARTS_CATEGORIES_DIR = join(JLCPARTS_DIR, "categories");
export const JLCPCB_DIR = join(RAW_DIR, "jlcpcb-api");
export const JLCPCB_PAGES_DIR = join(JLCPCB_DIR, "pages");
export const LCSC_DIR = join(RAW_DIR, "lcsc");
export const DATASHEETS_DIR = join(RAW_DIR, "datasheets");

export function ensureRawDirs(): void {
  mkdirSync(JLCPARTS_CATEGORIES_DIR, { recursive: true });
  mkdirSync(JLCPCB_PAGES_DIR, { recursive: true });
  mkdirSync(LCSC_DIR, { recursive: true });
  mkdirSync(DATASHEETS_DIR, { recursive: true });
}

/** Sanitize a query key for use as a directory name. */
export function slugify(queryKey: string): string {
  return queryKey
    .toLowerCase()
    .replace(/[>\s,&]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Path builders
export function jlcpartsIndexPath(): string {
  return join(JLCPARTS_DIR, "index.json");
}

export function jlcpartsHashesPath(): string {
  return join(JLCPARTS_DIR, "hashes.json");
}

export function jlcpartsDataPath(sourcename: string): string {
  return join(JLCPARTS_CATEGORIES_DIR, `${sourcename}.json.gz`);
}

export function jlcpartsStockPath(sourcename: string): string {
  return join(JLCPARTS_CATEGORIES_DIR, `${sourcename}.stock.json`);
}

export function jlcpcbManifestPath(): string {
  return join(JLCPCB_DIR, "manifest.json");
}

export function jlcpcbPageDir(slug: string): string {
  return join(JLCPCB_PAGES_DIR, slug);
}

export function jlcpcbPagePath(slug: string, pageNum: number): string {
  const padded = String(pageNum).padStart(3, "0");
  return join(JLCPCB_PAGES_DIR, slug, `page-${padded}.json`);
}

export function lcscEnrichmentPath(): string {
  return join(LCSC_DIR, "enrichment.ndjson");
}

// Datasheet path builders
export function datasheetPdfPath(lcsc: string): string {
  return join(DATASHEETS_DIR, `${lcsc}.pdf`);
}

export function datasheetTextPath(lcsc: string): string {
  return join(DATASHEETS_DIR, `${lcsc}.txt`);
}

export function datasheetUrlsPath(): string {
  return join(DATASHEETS_DIR, "urls.ndjson");
}

export function datasheetManifestPath(): string {
  return join(DATASHEETS_DIR, "manifest.json");
}
