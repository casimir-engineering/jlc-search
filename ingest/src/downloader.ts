import type { CategoryData, JlcpartsIndex, StockData } from "./types.ts";
import { gunzipSync } from "bun";

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
