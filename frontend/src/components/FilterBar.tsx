import type { Filters, SortOption } from "../types.ts";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "price_asc", label: "Price: low first" },
  { value: "price_desc", label: "Price: high first" },
  { value: "stock_desc", label: "Stock: most first" },
  { value: "stock_asc", label: "Stock: least first" },
];

interface Props {
  filters: Filters;
  onChange: (update: Partial<Filters>) => void;
  favoritesCount: number;
  cartMode: boolean;
  onCartModeChange: (v: boolean) => void;
  cartItemCount: number;
  cartTotal: number;
}

export function FilterBar({ filters, onChange, favoritesCount, cartMode, onCartModeChange, cartItemCount, cartTotal }: Props) {
  const basicActive = filters.partTypes.includes("Basic");

  return (
    <div className="filter-bar">
      <button
        className={`chip ${basicActive ? "chip-active" : ""}`}
        onClick={() => onChange({ partTypes: basicActive ? [] : ["Basic"] })}
      >
        Basic only
      </button>
      <label className="toggle-label">
        <input
          type="checkbox"
          checked={filters.inStock}
          onChange={(e) => onChange({ inStock: e.target.checked })}
        />
        In stock
      </label>
      <label className="toggle-label">
        <input
          type="checkbox"
          checked={filters.matchAll}
          onChange={(e) => onChange({ matchAll: e.target.checked })}
        />
        Match all terms
      </label>
      <label className="toggle-label">
        <input
          type="checkbox"
          checked={filters.fuzzy}
          onChange={(e) => onChange({ fuzzy: e.target.checked })}
        />
        Fuzzy search
      </label>
      <select
        className="sort-select"
        value={filters.sort}
        onChange={(e) => onChange({ sort: e.target.value as SortOption })}
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <div className="filter-spacer" />
      <button
        className={`chip ${cartMode ? "chip-active" : ""}`}
        onClick={() => onCartModeChange(!cartMode)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: '-2px', marginRight: '3px'}}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>
        </svg>
        BOM{cartItemCount > 0 ? ` (${cartItemCount})` : ""}
        {cartTotal > 0 ? ` $${cartTotal.toFixed(2)}` : ""}
      </button>
    </div>
  );
}
