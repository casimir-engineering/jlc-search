import { useState, useEffect } from "react";
import type { Filters, SortOption } from "../types.ts";

const PART_TYPES = ["Basic", "Preferred", "Extended", "Mechanical"];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "stock_desc", label: "Stock: High to Low" },
  { value: "stock_asc", label: "Stock: Low to High" },
];

interface Props {
  filters: Filters;
  onChange: (update: Partial<Filters>) => void;
  showApiData: boolean;
  onShowApiDataChange: (v: boolean) => void;
  favoritesOnly: boolean;
  onFavoritesOnlyChange: (v: boolean) => void;
  favoritesCount: number;
  onClearFavorites: () => void;
}

export function FilterBar({ filters, onChange, showApiData, onShowApiDataChange, favoritesOnly, onFavoritesOnlyChange, favoritesCount, onClearFavorites }: Props) {
  const [confirmClear, setConfirmClear] = useState(false);

  // Reset confirm state after 3s or when favorites count changes to 0
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  function handleClearClick() {
    if (confirmClear) {
      onClearFavorites();
      setConfirmClear(false);
    } else {
      setConfirmClear(true);
    }
  }

  function togglePartType(type: string) {
    const current = filters.partTypes;
    const next = current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type];
    onChange({ partTypes: next });
  }

  return (
    <div className="filter-bar">
      <div className="filter-group">
        <span className="filter-label">Part type:</span>
        {PART_TYPES.map((pt) => (
          <button
            key={pt}
            className={`chip ${filters.partTypes.includes(pt) ? "chip-active" : ""}`}
            onClick={() => togglePartType(pt)}
          >
            {pt}
          </button>
        ))}
      </div>

      <div className="filter-group">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={filters.inStock}
            onChange={(e) => onChange({ inStock: e.target.checked })}
          />
          In stock only
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
        <button
          className={`chip ${favoritesOnly ? "chip-active" : ""}`}
          onClick={() => onFavoritesOnlyChange(!favoritesOnly)}
        >
          {"\u2605"} Favorites{favoritesCount > 0 ? ` (${favoritesCount})` : ""}
        </button>
        {favoritesCount > 0 && (
          <button
            className={`chip ${confirmClear ? "chip-danger-confirm" : "chip-danger"}`}
            onClick={handleClearClick}
          >
            {confirmClear ? "Confirm clear" : "Clear favorites"}
          </button>
        )}
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={showApiData}
            onChange={(e) => onShowApiDataChange(e.target.checked)}
          />
          Show API data
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
      </div>
    </div>
  );
}
