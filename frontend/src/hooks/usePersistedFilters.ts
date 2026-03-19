import { useState, useCallback } from "react";
import type { Filters } from "../types.ts";

const STORAGE_KEY = "jlc-filters";
const FILTER_VERSION = 2; // Bump this when filter shape changes

interface StoredFilters {
  version: number;
  filters: Filters;
}

const DEFAULT_FILTERS: Filters = {
  partTypes: [],
  categories: [],
  stockFilter: "none",
  economicOnly: false,
  fuzzy: false,
  sort: "relevance",
  matchAll: false,
};

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const stored: StoredFilters = JSON.parse(raw);
    if (stored.version !== FILTER_VERSION) {
      // Version mismatch — discard saved filters
      localStorage.removeItem(STORAGE_KEY);
      return DEFAULT_FILTERS;
    }
    // Validate that all expected keys exist and have valid types
    const f = stored.filters;
    if (typeof f !== "object" || f === null) return DEFAULT_FILTERS;
    const valid: Filters = {
      partTypes: Array.isArray(f.partTypes) ? f.partTypes : DEFAULT_FILTERS.partTypes,
      categories: Array.isArray(f.categories) ? f.categories : DEFAULT_FILTERS.categories,
      stockFilter: ["none", "jlc", "lcsc", "any"].includes(f.stockFilter) ? f.stockFilter : DEFAULT_FILTERS.stockFilter,
      economicOnly: typeof f.economicOnly === "boolean" ? f.economicOnly : DEFAULT_FILTERS.economicOnly,
      fuzzy: typeof f.fuzzy === "boolean" ? f.fuzzy : DEFAULT_FILTERS.fuzzy,
      sort: ["relevance", "price_asc", "price_desc", "stock_desc", "stock_asc"].includes(f.sort) ? f.sort : DEFAULT_FILTERS.sort,
      matchAll: typeof f.matchAll === "boolean" ? f.matchAll : DEFAULT_FILTERS.matchAll,
    };
    return valid;
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(filters: Filters): void {
  try {
    const stored: StoredFilters = { version: FILTER_VERSION, filters };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

export { DEFAULT_FILTERS };

export function usePersistedFilters() {
  const [filters, setFiltersRaw] = useState<Filters>(loadFilters);

  const setFilters = useCallback((update: Partial<Filters>) => {
    setFiltersRaw((prev) => {
      const next = { ...prev, ...update };
      saveFilters(next);
      return next;
    });
  }, []);

  const resetFilters = useCallback(() => {
    setFiltersRaw(DEFAULT_FILTERS);
    saveFilters(DEFAULT_FILTERS);
  }, []);

  return { filters, setFilters, resetFilters };
}
