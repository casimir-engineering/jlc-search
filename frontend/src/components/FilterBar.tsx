import { useState, useEffect, useRef } from "react";
import type { Filters, SortOption, StockFilter } from "../types.ts";
import { fetchCategories } from "../api.ts";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "price_asc", label: "Price ↑" },
  { value: "price_desc", label: "Price ↓" },
  { value: "stock_desc", label: "Stock ↓" },
  { value: "stock_asc", label: "Stock ↑" },
];

const STOCK_OPTIONS: { value: StockFilter; label: string }[] = [
  { value: "none", label: "Any stock" },
  { value: "any", label: "In stock" },
  { value: "lcsc", label: "LCSC stock" },
  { value: "jlc", label: "JLC stock" },
];

interface Props {
  filters: Filters;
  onChange: (update: Partial<Filters>) => void;
  cartMode: boolean;
  onCartModeChange: (v: boolean) => void;
  cartItemCount: number;
  cartTotal: number;
}

/** Reusable chip-style dropdown */
function ChipDropdown({ label, active, children }: { label: string; active: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="chip-dropdown" ref={ref}>
      <button className={`chip ${active ? "chip-active" : ""}`} onClick={() => setOpen(!open)}>
        {label} <span className="chip-arrow">{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && <div className="chip-dropdown-menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

function CategorySelect({ selected, onChange }: { selected: string[]; onChange: (cats: string[]) => void }) {
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { fetchCategories().then(setCategories); }, []);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = search
    ? categories.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : categories;

  const toggle = (name: string) => {
    if (selected.includes(name)) onChange(selected.filter((c) => c !== name));
    else onChange([...selected, name]);
  };

  const label = selected.length === 0
    ? "Category"
    : selected.length === 1
      ? selected[0].length > 16 ? selected[0].substring(0, 14) + "…" : selected[0]
      : `${selected.length} categories`;

  return (
    <div className="chip-dropdown" ref={ref}>
      <button className={`chip ${selected.length > 0 ? "chip-active" : ""}`} onClick={() => setOpen(!open)}>
        {label} <span className="chip-arrow">{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && (
        <div className="category-dropdown">
          <input
            className="category-search"
            type="text"
            placeholder="Filter categories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {selected.length > 0 && (
            <button className="category-clear" onClick={() => { onChange([]); setSearch(""); }}>
              Clear all
            </button>
          )}
          <div className="category-list">
            {filtered.map((c) => (
              <label key={c.name} className={`category-item ${selected.includes(c.name) ? "category-active" : ""}`}>
                <input type="checkbox" checked={selected.includes(c.name)} onChange={() => toggle(c.name)} />
                <span className="category-name">{c.name}</span>
                <span className="category-count">{c.count.toLocaleString()}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function FilterBar({ filters, onChange, cartMode, onCartModeChange, cartItemCount, cartTotal }: Props) {
  const basicActive = filters.partTypes.includes("Basic");
  const jlcActive = basicActive || filters.economicOnly;
  const jlcLabel = basicActive && filters.economicOnly ? "Basic + Economic"
    : basicActive ? "Basic only"
    : filters.economicOnly ? "Economic only"
    : "JLC options";

  const stockLabel = STOCK_OPTIONS.find((o) => o.value === filters.stockFilter)?.label ?? "Any stock";
  const stockActive = filters.stockFilter !== "none";

  const sortLabel = SORT_OPTIONS.find((o) => o.value === filters.sort)?.label ?? "Relevance";
  const sortActive = filters.sort !== "relevance";

  const searchActive = filters.matchAll || filters.fuzzy;
  const searchLabel = filters.matchAll && filters.fuzzy ? "All + Fuzzy"
    : filters.matchAll ? "Match all"
    : filters.fuzzy ? "Fuzzy"
    : "Search";

  return (
    <div className="filter-bar">
      {/* JLC Options: Basic + Economic */}
      <ChipDropdown label={jlcLabel} active={jlcActive}>
        <label className="dropdown-item">
          <input type="checkbox" checked={basicActive} onChange={() => onChange({ partTypes: basicActive ? [] : ["Basic"] })} />
          Basic parts only
        </label>
        <label className="dropdown-item">
          <input type="checkbox" checked={filters.economicOnly} onChange={() => onChange({ economicOnly: !filters.economicOnly })} />
          Economic assembly only
        </label>
      </ChipDropdown>

      {/* Category */}
      <CategorySelect selected={filters.categories} onChange={(categories) => onChange({ categories })} />

      {/* Stock filter */}
      <ChipDropdown label={stockLabel} active={stockActive}>
        {STOCK_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`dropdown-item ${filters.stockFilter === o.value ? "dropdown-active" : ""}`}
            onClick={() => onChange({ stockFilter: o.value })}
          >
            {o.label}
          </button>
        ))}
      </ChipDropdown>

      {/* Sort */}
      <ChipDropdown label={sortLabel} active={sortActive}>
        {SORT_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`dropdown-item ${filters.sort === o.value ? "dropdown-active" : ""}`}
            onClick={() => onChange({ sort: o.value })}
          >
            {o.label}
          </button>
        ))}
      </ChipDropdown>

      {/* Search options */}
      <ChipDropdown label={searchLabel} active={searchActive}>
        <label className="dropdown-item">
          <input type="checkbox" checked={filters.matchAll} onChange={(e) => onChange({ matchAll: e.target.checked })} />
          Match all terms
        </label>
        <label className="dropdown-item">
          <input type="checkbox" checked={filters.fuzzy} onChange={(e) => onChange({ fuzzy: e.target.checked })} />
          Fuzzy search
        </label>
      </ChipDropdown>

      <div className="filter-spacer" />

      {/* BOM */}
      <button
        className={`chip ${cartMode ? "chip-active" : ""}`}
        onClick={() => onCartModeChange(!cartMode)}
      >
        BOM{cartItemCount > 0 ? ` (${cartItemCount})` : ""}
        {cartTotal > 0 ? ` $${cartTotal.toFixed(2)}` : ""}
      </button>
    </div>
  );
}
