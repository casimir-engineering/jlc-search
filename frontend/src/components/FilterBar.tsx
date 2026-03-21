import { useState, useEffect, useRef } from "react";
import type { Filters, SortOption, StockFilter } from "../types.ts";
import { fetchCategories } from "../api.ts";

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
  cartMode: boolean;
  onCartModeChange: (v: boolean) => void;
  cartItemCount: number;
  cartTotal: number;
}

/** Generic chip-style dropdown: button with ▼ arrow, click to open a list of options. */
function ChipSelect<T extends string>({ value, options, onChange, active }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const current = options.find((o) => o.value === value);

  return (
    <div className="category-select" ref={ref}>
      <button className={`chip ${active ? "chip-active" : ""}`} onClick={() => setOpen(!open)}>
        {current?.label ?? value}
        <span className="chip-arrow">{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && (
        <div className="chip-select-dropdown">
          {options.map((o) => (
            <button
              key={o.value}
              className={`chip-select-option ${o.value === value ? "chip-select-active" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CategorySelect({ selected, onChange }: { selected: string[]; onChange: (cats: string[]) => void }) {
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCategories().then(setCategories);
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const filtered = search
    ? categories.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : categories;

  const toggle = (name: string) => {
    if (selected.includes(name)) onChange(selected.filter((c) => c !== name));
    else onChange([...selected, name]);
  };

  return (
    <div className="category-select" ref={ref}>
      <button
        className={`chip ${selected.length > 0 ? "chip-active" : ""}`}
        onClick={() => setOpen(!open)}
      >
        {selected.length === 0
          ? "All categories"
          : selected.length === 1
            ? selected[0]
            : `${selected.length} categories`}
        <span className="chip-arrow">{open ? "\u25B2" : "\u25BC"}</span>
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
                <input
                  type="checkbox"
                  checked={selected.includes(c.name)}
                  onChange={() => toggle(c.name)}
                />
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

  return (
    <div className="filter-bar">
      <label className="toggle-label">
        <input type="checkbox" checked={basicActive} onChange={() => onChange({ partTypes: basicActive ? [] : ["Basic"] })} />
        Basic
      </label>
      <label className="toggle-label">
        <input type="checkbox" checked={filters.economicOnly} onChange={() => onChange({ economicOnly: !filters.economicOnly })} />
        Economic
      </label>
      <CategorySelect
        selected={filters.categories}
        onChange={(categories) => onChange({ categories })}
      />
      <ChipSelect
        value={filters.stockFilter}
        active={filters.stockFilter !== "none"}
        options={[
          { value: "none" as StockFilter, label: "Any stock" },
          { value: "any" as StockFilter, label: "In stock" },
          { value: "lcsc" as StockFilter, label: "LCSC stock" },
          { value: "jlc" as StockFilter, label: "JLC stock" },
        ]}
        onChange={(v) => onChange({ stockFilter: v })}
      />
      <label className="toggle-label">
        <input
          type="checkbox"
          checked={filters.matchAll}
          onChange={(e) => onChange({ matchAll: e.target.checked })}
        />
        Match all terms
      </label>
      <ChipSelect
        value={filters.sort}
        active={filters.sort !== "relevance"}
        options={SORT_OPTIONS}
        onChange={(v) => onChange({ sort: v })}
      />
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
