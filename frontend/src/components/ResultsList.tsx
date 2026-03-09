import type { PartSummary } from "../types.ts";
import { PartCard } from "./PartCard.tsx";

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
  showApiData: boolean;
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

export function ResultsList({ results, total, loading, error, query, tookMs, page, totalPages, pageSize, onPageChange, showApiData }: Props) {
  if (error) {
    return (
      <div className="results-message error">
        <strong>Error:</strong> {error}
      </div>
    );
  }

  if (!query.trim()) {
    return (
      <div className="results-empty-state">
        <p>Search for JLCPCB/LCSC parts by:</p>
        <ul>
          <li>LCSC code — <code>C22074</code></li>
          <li>Manufacturer part number — <code>RC0402JR-0710KL</code></li>
          <li>Keywords — <code>100nF 0402 ceramic</code></li>
          <li>Connector description — <code>1.25 picoblade horizontal smd</code></li>
          <li>Range filters — <code>F:100n-&gt;1u V:&gt;25</code>, <code>Ohm:&lt;2m</code>, <code>pads:4</code></li>
        </ul>
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
        {total > 0 && (
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
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
      <div className="results-list">
        {results.map((part) => (
          <PartCard key={part.lcsc} part={part} showApiData={showApiData} />
        ))}
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </>
  );
}
