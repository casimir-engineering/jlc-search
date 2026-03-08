import type { Filters } from "../types.ts";

const PART_TYPES = ["Basic", "Preferred", "Extended", "Mechanical"];

interface Props {
  filters: Filters;
  onChange: (update: Partial<Filters>) => void;
}

export function FilterBar({ filters, onChange }: Props) {
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
            checked={filters.fuzzy}
            onChange={(e) => onChange({ fuzzy: e.target.checked })}
          />
          Fuzzy search
        </label>
      </div>
    </div>
  );
}
