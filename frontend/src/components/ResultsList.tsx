import type { PartSummary } from "../types.ts";
import { PartCard } from "./PartCard.tsx";
import { CartSummary } from "./CartSummary.tsx";

interface Props {
  results: PartSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  query: string;
  tookMs: number | null;
  page: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  favorites: Set<string>;
  onToggleFavorite: (lcsc: string) => void;
  favoritesOnly: boolean;
  quantities: Record<string, number>;
  onQuantityChange: (lcsc: string, qty: number) => void;
  bomParts: PartSummary[];
  hasFavorites: boolean;
  onClearAll: () => void;
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (p: number) => void }) {
  if (totalPages <= 1) return null;

  // Build page numbers to show: current +/- 2, plus first and last
  const pages: (number | "...")[] = [];
  for (let i = 0; i < totalPages; i++) {
    if (i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 2) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== "...") {
      pages.push("...");
    }
  }

  return (
    <div className="pagination">
      <button
        className="pagination-btn"
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        Prev
      </button>
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`ellipsis-${i}`} className="pagination-ellipsis">...</span>
        ) : (
          <button
            key={p}
            className={`pagination-btn ${p === page ? "pagination-active" : ""}`}
            onClick={() => onPageChange(p)}
          >
            {p + 1}
          </button>
        )
      )}
      <button
        className="pagination-btn"
        disabled={page >= totalPages - 1}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </button>
    </div>
  );
}

export function ResultsList({ results, total, loading, error, query, tookMs, page, totalPages, pageSize, onPageChange, favorites, onToggleFavorite, favoritesOnly, quantities, onQuantityChange, bomParts, hasFavorites, onClearAll }: Props) {
  if (error) {
    return (
      <div className="results-message error">
        <strong>Error:</strong> {error}
      </div>
    );
  }

  if (!query.trim() && !favoritesOnly) {
    return (
      <div className="results-empty-state">
        <p>Search for JLCPCB/LCSC parts by:</p>
        <ul>
          <li>LCSC code — <code>C22074</code></li>
          <li>Manufacturer part number — <code>RC0402JR-0710KL</code></li>
          <li>Keywords — <code>100nF 0402 ceramic</code></li>
          <li>Connector description — <code>1.25 picoblade horizontal smd</code></li>
          <li>Range filters — <code>F:100n-&gt;1u V:&gt;25</code>, <code>Ohm:&lt;2m</code>, <code>pads:4</code></li>
          <li>Exclude terms — <code>PADAUK -OTP</code></li>
          <li>Exact phrase — <code>"Thick Film"</code></li>
        </ul>
        <p style={{marginTop: '1rem', fontSize: '0.85rem'}}>
          <a href="https://github.com/casimir-engineering/jlc-search" target="_blank" rel="noopener noreferrer">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{verticalAlign: '-2px', marginRight: '4px'}}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            Star on GitHub
          </a>
        </p>
      </div>
    );
  }

  if (loading && results.length === 0) {
    return (
      <div className="results-list">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="part-card skeleton" />
        ))}
      </div>
    );
  }

  if (!loading && results.length === 0) {
    if (favoritesOnly && !query.trim()) {
      return (
        <div className="results-message">
          No favorites yet. Click the star on any part to add it.
        </div>
      );
    }
    return (
      <div className="results-message">
        No results for <strong>"{query}"</strong>.
        {" "}Try enabling fuzzy search or broadening your query.
      </div>
    );
  }

  const startIdx = page * pageSize + 1;
  const endIdx = Math.min(page * pageSize + results.length, total);

  return (
    <>
      <div className="results-meta">
        {total > 0 && query.trim() && (
          <span>
            {totalPages > 1
              ? `${startIdx}-${endIdx} of ${total.toLocaleString()}`
              : `${total.toLocaleString()}`
            }
            {" "}result{total !== 1 ? "s" : ""} for{" "}
            <strong>"{query}"</strong>
            {tookMs != null && <span className="took-ms"> ({tookMs}ms)</span>}
          </span>
        )}
        {total > 0 && !query.trim() && favoritesOnly && (
          <span>{total} favorite{total !== 1 ? "s" : ""}</span>
        )}
      </div>
      {hasFavorites && <CartSummary parts={bomParts} quantities={quantities} onClearAll={onClearAll} />}
      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
      <div className={`results-list${loading ? " results-loading" : ""}`}>
        {results.map((part) => (
          <PartCard key={part.lcsc} part={part} isFavorite={favorites.has(part.lcsc)} onToggleFavorite={onToggleFavorite} quantity={quantities[part.lcsc]} onQuantityChange={onQuantityChange} searchQuery={query} />
        ))}
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </>
  );
}
