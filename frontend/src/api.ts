import type { SearchResponse, SortOption } from "./types.ts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export async function searchParts(
  q: string,
  filters: { partTypes: string[]; inStock: boolean; fuzzy: boolean; sort: SortOption; matchAll: boolean },
  options?: { signal?: AbortSignal; limit?: number; offset?: number }
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q });
  for (const pt of filters.partTypes) params.append("partType", pt);
  if (filters.inStock) params.set("inStock", "true");
  if (filters.fuzzy) params.set("fuzzy", "true");
  if (filters.sort !== "relevance") params.set("sort", filters.sort);
  if (filters.matchAll) params.set("matchAll", "true");
  params.set("limit", String(options?.limit ?? 50));
  if (options?.offset) params.set("offset", String(options.offset));

  const res = await fetch(`${API_BASE}/api/search?${params}`, {
    signal: options?.signal,
  });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function fetchPartsByIds(
  ids: string[],
  signal?: AbortSignal
): Promise<{ results: import("./types.ts").PartSummary[] }> {
  if (ids.length === 0) return { results: [] };
  const res = await fetch(`${API_BASE}/api/parts/batch?ids=${ids.join(",")}`, { signal });
  if (!res.ok) throw new Error(`Batch fetch failed: ${res.status}`);
  return res.json();
}

export async function getStatus(): Promise<{
  total_parts: number;
  last_ingested: string | null;
  categories_count: number;
}> {
  const res = await fetch(`${API_BASE}/api/status`);
  if (!res.ok) throw new Error("Status fetch failed");
  return res.json();
}
