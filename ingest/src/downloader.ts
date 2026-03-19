import type { CategoryData, JlcpartsIndex, StockData } from "./types.ts";
import { gunzipSync } from "bun";
import { writeFileSync, renameSync } from "fs";

export async function fetchIndex(base: string): Promise<JlcpartsIndex> {
  const url = `${base}/data/index.json`;
  console.log(`Fetching index from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch index: ${res.status} ${res.statusText}`);
  return res.json() as Promise<JlcpartsIndex>;
}

export async function fetchCategoryData(
  base: string,
  sourcename: string
): Promise<CategoryData> {
  const url = `${base}/data/${sourcename}.json.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const decompressed = gunzipSync(buf);
  return JSON.parse(new TextDecoder().decode(decompressed)) as CategoryData;
}

export async function fetchStockData(
  base: string,
  sourcename: string
): Promise<StockData> {
  const url = `${base}/data/${sourcename}.stock.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<StockData>;
}

// File-saving download variants (write raw bytes to disk, no parsing)

/** Fetch index.json and write to destPath (atomic via tmp+rename). */
export async function downloadIndexToFile(base: string, destPath: string): Promise<void> {
  const url = `${base}/data/index.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch index: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const tmp = destPath + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, destPath);
}

/** Fetch .json.gz category data and write raw compressed bytes to destPath. */
export async function downloadCategoryDataToFile(base: string, sourcename: string, destPath: string): Promise<void> {
  const url = `${base}/data/${sourcename}.json.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const tmp = destPath + ".tmp";
  writeFileSync(tmp, buf);
  renameSync(tmp, destPath);
}

/** Fetch .stock.json and write raw text to destPath. */
export async function downloadStockDataToFile(base: string, sourcename: string, destPath: string): Promise<void> {
  const url = `${base}/data/${sourcename}.stock.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const tmp = destPath + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, destPath);
}
