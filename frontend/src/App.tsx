import { useState, useEffect, useRef } from "react";
import { useSearch } from "./hooks/useSearch.ts";
import { useFavorites } from "./hooks/useFavorites.ts";
import { fetchPartsByIds } from "./api.ts";
import { SearchBar } from "./components/SearchBar.tsx";
import { FilterBar } from "./components/FilterBar.tsx";
import { ResultsList } from "./components/ResultsList.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import type { PartSummary } from "./types.ts";

export function App() {
  const {
    query, setQuery, filters, setFilters,
    results, total, loading, error, tookMs,
    page, setPage, totalPages, pageSize,
  } = useSearch();
  const [showApiData, setShowApiData] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { favorites, toggle: toggleFavorite, clearAll: clearFavorites } = useFavorites();

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

  // Determine which results to display
  const showFavPage = favoritesOnly && !query.trim();
  const displayResults = showFavPage
    ? favResults
    : favoritesOnly
      ? results.filter((r) => favorites.has(r.lcsc))
      : results;
  const displayTotal = showFavPage
    ? favResults.length
    : favoritesOnly
      ? displayResults.length
      : total;
  const displayLoading = showFavPage ? favLoading : loading;

  const hasResults = displayResults.length > 0 || query.trim().length > 0 || favoritesOnly;

  return (
    <div className={`app ${hasResults ? "app-results-mode" : "app-home-mode"}`}>
      <header className="app-header">
        <div className="app-logo">
          <span className="logo-text">jst-search</span>
          <span className="logo-sub">JLCPCB parts</span>
        </div>

        <SearchBar value={query} onChange={setQuery} loading={loading} />
        <FilterBar
          filters={filters}
          onChange={setFilters}
          showApiData={showApiData}
          onShowApiDataChange={setShowApiData}
          favoritesOnly={favoritesOnly}
          onFavoritesOnlyChange={setFavoritesOnly}
          favoritesCount={favorites.size}
          onClearFavorites={clearFavorites}
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
          showApiData={showApiData}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          favoritesOnly={favoritesOnly}
        />
      </main>

      <footer className="app-footer">
        <StatusBar />
      </footer>
    </div>
  );
}
