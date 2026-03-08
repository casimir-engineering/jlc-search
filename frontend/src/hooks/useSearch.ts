import { useState, useEffect, useRef, useCallback } from "react";
import { searchParts } from "../api.ts";
import type { Filters, PartSummary } from "../types.ts";

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function getUrlParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

export function useSearch() {
  const [query, setQuery] = useState(() => getUrlParam("q"));
  const [results, setResults] = useState<PartSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tookMs, setTookMs] = useState<number | null>(null);

  const debouncedQuery = useDebounce(query, 250);
  const abortRef = useRef<AbortController | null>(null);

  const [filters, setFiltersState] = useState<Filters>({
    partTypes: [],
    inStock: false,
    fuzzy: false,
  });

  const setFilters = useCallback((update: Partial<Filters>) => {
    setFiltersState((prev) => ({ ...prev, ...update }));
  }, []);

  // Sync query to URL
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url.toString());
  }, [query]);

  // Perform search
  useEffect(() => {
    if (debouncedQuery.trim().length < 1) {
      setResults([]);
      setTotal(0);
      setTookMs(null);
      setError(null);
      return;
    }

    // Cancel previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    searchParts(debouncedQuery, filters, { signal: controller.signal })
      .then((data) => {
        setResults(data.results);
        setTotal(data.total);
        setTookMs(data.took_ms);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Search failed");
        setLoading(false);
      });

    return () => controller.abort();
  }, [debouncedQuery, filters]);

  return {
    query,
    setQuery,
    filters,
    setFilters,
    results,
    total,
    loading,
    error,
    tookMs,
  };
}
