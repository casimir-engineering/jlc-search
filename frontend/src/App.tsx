import { useSearch } from "./hooks/useSearch.ts";
import { SearchBar } from "./components/SearchBar.tsx";
import { FilterBar } from "./components/FilterBar.tsx";
import { ResultsList } from "./components/ResultsList.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

export function App() {
  const { query, setQuery, filters, setFilters, results, total, loading, error, tookMs } =
    useSearch();

  const hasResults = results.length > 0 || query.trim().length > 0;

  return (
    <div className={`app ${hasResults ? "app-results-mode" : "app-home-mode"}`}>
      <header className="app-header">
        <div className="app-logo">
          <span className="logo-text">jst-search</span>
          <span className="logo-sub">JLCPCB parts</span>
        </div>

        <SearchBar value={query} onChange={setQuery} loading={loading} />
        <FilterBar filters={filters} onChange={setFilters} />
      </header>

      <main className="app-main">
        <ResultsList
          results={results}
          total={total}
          loading={loading}
          error={error}
          query={query}
          tookMs={tookMs}
        />
      </main>

      <footer className="app-footer">
        <StatusBar />
      </footer>
    </div>
  );
}
