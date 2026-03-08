import type { PartSummary } from "../types.ts";
import { PartCard } from "./PartCard.tsx";

interface Props {
  results: PartSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  query: string;
  tookMs: number | null;
}

export function ResultsList({ results, total, loading, error, query, tookMs }: Props) {
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

  return (
    <>
      <div className="results-meta">
        {total > 0 && (
          <span>
            {total.toLocaleString()} result{total !== 1 ? "s" : ""} for{" "}
            <strong>"{query}"</strong>
            {tookMs != null && <span className="took-ms"> ({tookMs}ms)</span>}
          </span>
        )}
      </div>
      <div className="results-list">
        {results.map((part) => (
          <PartCard key={part.lcsc} part={part} />
        ))}
      </div>
    </>
  );
}
