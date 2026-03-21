import { useState, useEffect, useRef, useCallback } from "react";
import { useSearch } from "./hooks/useSearch.ts";
import { useFavorites } from "./hooks/useFavorites.ts";
import { useCart } from "./hooks/useCart.ts";
import { useLiveRefresh } from "./hooks/useLiveRefresh.ts";
import { getLineTotal, getUnitPrice } from "./utils/price.ts";
import { decodeCartFromHash } from "./utils/share.ts";
import { fetchPartsByIds } from "./api.ts";
import { SearchBar } from "./components/SearchBar.tsx";
import { FilterBar } from "./components/FilterBar.tsx";
import { ResultsList } from "./components/ResultsList.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import type { Filters, PartSummary } from "./types.ts";
import { DEFAULT_FILTERS } from "./hooks/usePersistedFilters.ts";

export function App() {
  const {
    query, setQuery, filters, setFilters,
    results, setResults, total, loading, error, tookMs,
    page, setPage, totalPages, pageSize,
  } = useSearch();
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { favorites, toggle: toggleFavorite, clearAll: clearFavorites } = useFavorites();
  const { quantities, setQuantity, initQuantity, mergeQuantities } = useCart(favorites);
  const [cartMode, setCartMode] = useState(false);

  // Stash search state when entering BOM mode, restore on exit
  const savedSearchRef = useRef<{ query: string; filters: Filters } | null>(null);

  // Live-refresh stale parts (null moq) after backend LCSC API update
  useLiveRefresh(results, setResults);

  // Fetch favorite parts when in favorites-only mode with no query
  const [favResults, setFavResults] = useState<PartSummary[]>([]);
  const [favLoading, setFavLoading] = useState(false);
  const favAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!favoritesOnly || query.trim().length > 0) {
      setFavResults([]);
      return;
    }
    if (favorites.size === 0) {
      setFavResults([]);
      return;
    }

    favAbortRef.current?.abort();
    const controller = new AbortController();
    favAbortRef.current = controller;

    setFavLoading(true);
    fetchPartsByIds([...favorites], controller.signal)
      .then((data) => {
        setFavResults(data.results);
        setFavLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setFavLoading(false);
      });

    return () => controller.abort();
  }, [favoritesOnly, favorites, query]);

  const setFavResultsUpdater = useCallback(
    (updater: (prev: PartSummary[]) => PartSummary[]) => setFavResults(updater),
    [],
  );
  useLiveRefresh(favResults, setFavResultsUpdater);

  // Always fetch favorite parts data for BOM totals, independent of favoritesOnly mode
  const [bomParts, setBomParts] = useState<PartSummary[]>([]);
  const bomAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (favorites.size === 0) {
      setBomParts([]);
      return;
    }

    bomAbortRef.current?.abort();
    const controller = new AbortController();
    bomAbortRef.current = controller;

    fetchPartsByIds([...favorites], controller.signal)
      .then((data) => {
        setBomParts(data.results);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
      });

    return () => controller.abort();
  }, [favorites]);

  const setBomPartsUpdater = useCallback(
    (updater: (prev: PartSummary[]) => PartSummary[]) => setBomParts(updater),
    [],
  );
  useLiveRefresh(bomParts, setBomPartsUpdater);

  // Hydrate from share link on mount
  useEffect(() => {
    const shared = decodeCartFromHash(window.location.hash);
    if (shared) {
      // Add shared parts to favorites
      for (const lcsc of Object.keys(shared)) {
        if (!favorites.has(lcsc)) toggleFavorite(lcsc);
      }
      mergeQuantities(shared);
      setCartMode(true);
      setFavoritesOnly(true);
      // Clean hash
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Determine which results to display
  const showFavPage = favoritesOnly && !query.trim();
  const displayResults = (() => {
    if (cartMode) {
      // BOM mode: client-side filter + sort on bomParts
      let items = bomParts;
      const q = query.trim().toLowerCase();
      if (q) {
        items = items.filter((p) =>
          p.lcsc.toLowerCase().includes(q) ||
          p.mpn.toLowerCase().includes(q) ||
          (p.manufacturer ?? "").toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          (p.package ?? "").toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.subcategory.toLowerCase().includes(q)
        );
      }
      if (filters.stockFilter === "lcsc") items = items.filter((p) => p.stock > 0);
      else if (filters.stockFilter === "jlc") items = items.filter((p) => p.jlc_stock > 0);
      else if (filters.stockFilter === "any") items = items.filter((p) => p.stock > 0 || p.jlc_stock > 0);
      if (filters.partTypes.length > 0) items = items.filter((p) => filters.partTypes.includes(p.part_type));
      if (filters.sort !== "relevance") {
        items = [...items].sort((a, b) => {
          switch (filters.sort) {
            case "price_asc": return getUnitPrice(a.price_raw, 1) - getUnitPrice(b.price_raw, 1);
            case "price_desc": return getUnitPrice(b.price_raw, 1) - getUnitPrice(a.price_raw, 1);
            case "stock_desc": return b.stock - a.stock;
            case "stock_asc": return a.stock - b.stock;
            default: return 0;
          }
        });
      }
      return items;
    }
    if (showFavPage) return favResults;
    if (favoritesOnly) return results.filter((r) => favorites.has(r.lcsc));
    return results;
  })();
  const displayTotal = (cartMode || showFavPage || favoritesOnly) ? displayResults.length : total;
  const displayLoading = showFavPage ? favLoading : loading;

  // When favoriting, init quantity with MOQ
  const handleToggleFavorite = useCallback((lcsc: string) => {
    const wasFavorite = favorites.has(lcsc);
    toggleFavorite(lcsc);
    if (!wasFavorite) {
      // Find price_raw from available results
      const allParts = [...results, ...favResults, ...bomParts];
      const part = allParts.find((p) => p.lcsc === lcsc);
      if (part) {
        initQuantity(lcsc, 1);
      }
    }
  }, [favorites, toggleFavorite, initQuantity, results, favResults, bomParts]);

  // Cart totals — computed from bomParts (always available when favorites exist)
  const cartItemCount = bomParts.reduce((count, p) => {
    const qty = quantities[p.lcsc] ?? 0;
    return count + (qty > 0 ? 1 : 0);
  }, 0);
  const cartTotal = bomParts.reduce((sum, p) => {
    const qty = quantities[p.lcsc] ?? 0;
    return sum + getLineTotal(p.price_raw, qty);
  }, 0);

  // Cart mode: save search state on enter, restore on exit
  const handleCartModeChange = useCallback((v: boolean) => {
    if (v) {
      savedSearchRef.current = { query, filters };
      setQuery("");
      setFilters(DEFAULT_FILTERS);
    } else {
      if (savedSearchRef.current) {
        setQuery(savedSearchRef.current.query);
        setFilters(savedSearchRef.current.filters);
        savedSearchRef.current = null;
      }
    }
    setCartMode(v);
    setFavoritesOnly(v);
  }, [query, filters, setQuery, setFilters]);

  const hasResults = displayResults.length > 0 || query.trim().length > 0 || favoritesOnly;

  return (
    <div className={`app ${hasResults ? "app-results-mode" : "app-home-mode"}`}>
      <div className="donate-bar">
        <span>Did this save you time? Help cover our Asia hosting costs.</span>
        <a href="/donate" className="donate-btn">15s donation</a>
      </div>
      <header className="app-header">
        <div className="app-logo">
          <span className="logo-text">jlc-search</span>
          <span className="logo-sub">JLCPCB parts</span>
        </div>

        <SearchBar value={query} onChange={setQuery} loading={loading} />
        <FilterBar
          filters={filters}
          onChange={setFilters}
          cartMode={cartMode}
          onCartModeChange={handleCartModeChange}
          cartItemCount={cartItemCount}
          cartTotal={cartTotal}
        />
      </header>

      <main className="app-main">
        <ResultsList
          results={displayResults}
          total={displayTotal}
          loading={displayLoading}
          error={showFavPage ? null : error}
          query={query}
          tookMs={showFavPage ? null : tookMs}
          page={showFavPage ? 0 : page}
          totalPages={showFavPage ? 1 : (favoritesOnly ? 1 : totalPages)}
          pageSize={pageSize}
          onPageChange={setPage}
          favorites={favorites}
          onToggleFavorite={handleToggleFavorite}
          favoritesOnly={favoritesOnly}
          quantities={quantities}
          onQuantityChange={setQuantity}
          bomParts={bomParts}
          hasFavorites={favorites.size > 0}
          onClearAll={() => { clearFavorites(); handleCartModeChange(false); }}
        />
      </main>

      <footer className="app-footer">
        <StatusBar />
      </footer>
    </div>
  );
}
