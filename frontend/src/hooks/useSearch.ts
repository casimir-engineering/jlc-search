import { useState, useEffect, useRef, useCallback } from "react";
import { searchParts } from "../api.ts";
import type { Filters, PartSummary } from "../types.ts";
import { usePersistedFilters } from "./usePersistedFilters.ts";

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 80; // Short debounce — just enough to batch rapid keystrokes

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
  const [page, setPage] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { filters, setFilters: updateFilters } = usePersistedFilters();

  const setFilters = useCallback((update: Partial<Filters>) => {
    updateFilters(update);
    setPage(0);
  }, [updateFilters]);

  const setQueryAndReset = useCallback((q: string) => {
    setQuery(q);
    setPage(0);
  }, []);

  // Sync query to URL
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url.toString());
  }, [query]);

  // Perform search with minimal debounce
  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < 1) {
      setResults([]);
      setTotal(0);
      setTookMs(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Show loading immediately (dims stale results)
    setLoading(true);

    // Cancel pending request and timer
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();

    // Short debounce — just batches rapid keystrokes
    timerRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;

      searchParts(trimmed, filters, {
        signal: controller.signal,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
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
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [query, filters, page]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return {
    query,
    setQuery: setQueryAndReset,
    filters,
    setFilters,
    results,
    setResults,
    total,
    loading,
    error,
    tookMs,
    page,
    setPage,
    totalPages,
    pageSize: PAGE_SIZE,
  };
}
